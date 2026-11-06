// Converts a session's Durable records from Durable's SQLite storage (`sessions/<id>.sqlite`, the layout before per-host
// stores) into `StoreStorage` on the session's Chord store, and verifies the copy through the `Storage` interface.
//
// SQLite storage keeps no commit log, only what Durable reads: the latest conversation, task and submission records,
// every entry with the seq of the commit that stored it, and each document's record (created and retired at seqs) with
// its stored revisions (all of a rewindable conversation document's, the latest base and later deltas of any other).
// The conversion replays that as commits in seq order: one first commit with every conversation, task and submission
// record, then one commit per old seq that stored an entry or a document change. Seqs are renumbered (the new store
// numbers its own commits) but keep their order, so every read at a point (an entry's commit seq, a document's
// lifetime, a rewindable document as of an entry) answers as before; `SeqMap` translates. A document whose earliest
// kept revision is later than its creation (a latest-only document checkpointed since) is created with that base: its
// earlier states were never readable. A retired latest-only document kept no content and is created with an empty
// base: retired, it is never read. Ids stay; the allocator is raised past the old storage's next id.
import { DatabaseSync } from "node:sqlite";
import type { ChordStore, Store } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type {
	ConversationRecord,
	Cursor,
	DocumentContent,
	DocumentCreate,
	DocumentId,
	DocumentRecord,
	EntryRecord,
	JsonObject,
	Page,
	Seq,
	Storage,
	StorageWrite,
	SubmissionRecord,
	TaskId,
	TaskRecord,
} from "@earendil-works/pi-durable";

/** Old seq to new seq. */
export type SeqMap = ReadonlyMap<number, number>;

/** What a conversion wrote. */
export type DurableCounts = {
	readonly conversations: number;
	readonly entries: number;
	readonly tasks: number;
	readonly submissions: number;
	readonly documents: number;
	readonly revisions: number;
};

/** Commits per `Storage.commit` call (one backend transaction each). */
const COMMITS_PER_CALL = 200;

type Row = Record<string, string | number | null>;
type StoredTask = TaskRecord<unknown, unknown, unknown> & { readonly id: TaskId };

/**
 * Replays the SQLite storage file `oldPath` (opened read-only) into `storage`, a fresh `StoreStorage` over `store`.
 * Returns the seq map and the counts.
 */
export async function convertDurable(
	oldPath: string,
	storage: Storage,
	store: Store,
	context: Context,
): Promise<{ readonly seqs: SeqMap; readonly counts: DurableCounts }> {
	const db = new DatabaseSync(oldPath, { readOnly: true });
	try {
		const records = <T>(sql: string): T[] =>
			(db.prepare(sql).all() as Row[]).map((row) => JSON.parse(String(row.record)) as T);
		const conversations = records<ConversationRecord>("SELECT record FROM conversations ORDER BY id");
		const tasks = records<StoredTask>("SELECT record FROM tasks ORDER BY id");
		const submissions = records<SubmissionRecord>("SELECT record FROM submissions ORDER BY id");
		const first: StorageWrite[] = [
			...conversations.map((value) => ({ type: "conversation" as const, value })),
			...tasks.map((value) => ({ type: "task" as const, value: value as TaskRecord<never, never, never> })),
			...submissions.map((value) => ({ type: "submission" as const, value })),
		];
		const bySeq = new Map<number, StorageWrite[]>();
		const at = (seq: number): StorageWrite[] => {
			const writes = bySeq.get(seq) ?? [];
			bySeq.set(seq, writes);
			return writes;
		};
		const entries = db.prepare("SELECT commit_seq, record FROM entries ORDER BY id").all() as Row[];
		for (const row of entries)
			at(Number(row.commit_seq)).push({ type: "entry", value: JSON.parse(String(row.record)) as EntryRecord });
		const revisions = new Map<number, Row[]>();
		for (const row of db
			.prepare("SELECT document_id, seq, kind, version, content FROM document_revisions ORDER BY document_id, seq")
			.all() as Row[]) {
			const id = Number(row.document_id);
			revisions.set(id, [...(revisions.get(id) ?? []), row]);
		}
		const documents = db
			.prepare("SELECT id, created_at, retired_at, record FROM documents ORDER BY id")
			.all() as Row[];
		for (const row of documents) replayDocument(row, revisions.get(Number(row.id)) ?? [], at);
		const meta = db.prepare("SELECT next_id FROM durable_metadata WHERE singleton = 1").get() as Row | undefined;
		// Ids Durable minted ahead (in a checkpoint, say) stay taken: the allocator continues past the old next id.
		(store as ChordStore).ids.raise(Number(meta?.next_id ?? 2) - 1);
		const seqs = new Map<number, number>();
		const order = [...bySeq.keys()].sort((a, b) => a - b);
		const batches: { old: number | undefined; writes: StorageWrite[] }[] = [
			{ old: undefined, writes: first },
			...order.map((old) => ({ old, writes: bySeq.get(old)! })),
		];
		for (let start = 0; start < batches.length; start += COMMITS_PER_CALL) {
			const chunk = batches.slice(start, start + COMMITS_PER_CALL);
			const result = await storage.commit(
				chunk.map((batch) => batch.writes),
				(index, seq) => {
					const old = chunk[index]!.old;
					if (old !== undefined) seqs.set(old, seq);
				},
				context,
			);
			if (result.refused !== undefined || result.stored !== chunk.length)
				throw new Error(`The store refused a replayed commit`, { cause: result.refused });
		}
		return {
			seqs,
			counts: {
				conversations: conversations.length,
				entries: entries.length,
				tasks: tasks.length,
				submissions: submissions.length,
				documents: documents.length,
				revisions: [...revisions.values()].reduce((sum, list) => sum + list.length, 0),
			},
		};
	} finally {
		db.close();
	}
}

/** Stages one old document's creation, kept revisions and retirement at their seqs (`at(seq)`). */
function replayDocument(row: Row, revisions: readonly Row[], at: (seq: number) => StorageWrite[]): void {
	const id = Number(row.id) as DocumentId;
	const { createdAt: _created, retiredAt: _retired, ...create } = JSON.parse(String(row.record)) as DocumentRecord;
	const [base, ...later] = revisions;
	if (base !== undefined && base.kind !== "base") throw new Error(`Document ${id}'s earliest revision is no base`);
	if (base === undefined && row.retired_at === null) throw new Error(`Live document ${id} has no content`);
	const content: Extract<DocumentContent, { kind: "base" }> =
		base === undefined
			? { kind: "base", version: 1, value: {} }
			: { kind: "base", version: Number(base.version), value: JSON.parse(String(base.content)) as JsonObject };
	at(Number(row.created_at)).push({ type: "document.create", record: create as DocumentCreate, content });
	for (const revision of later) {
		const parsed = JSON.parse(String(revision.content)) as unknown;
		const version = Number(revision.version);
		const change: DocumentContent =
			revision.kind === "base"
				? { kind: "base", version, value: parsed as JsonObject }
				: { kind: "delta", version, ops: parsed as Extract<DocumentContent, { kind: "delta" }>["ops"] };
		at(Number(revision.seq)).push({ type: "document.change", id, content: change });
	}
	if (row.retired_at !== null) at(Number(row.retired_at)).push({ type: "document.retire", id });
}

/**
 * Reads every record through `Storage` from the old storage and the new one and compares them, seqs translated by
 * `seqs`: conversations, every conversation's entries (with their commit seqs and latest head marker), tasks,
 * submissions, every scope's current documents (records and values), every rewindable document at each of its kept
 * revisions, and every document's record. Throws at the first difference.
 */
export async function verifyDurable(
	before: Storage,
	after: Storage,
	oldPath: string,
	seqs: SeqMap,
	context: Context,
): Promise<void> {
	const mapSeq = (seq: number): number => {
		const mapped = seqs.get(seq);
		if (mapped === undefined) throw new Error(`No new seq for old seq ${seq}`);
		return mapped;
	};
	const same = (what: string, a: unknown, b: unknown): void => {
		if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} differs after the conversion`);
	};
	const conversations = await all((cursor) => before.scanConversations({}, 500, cursor, context));
	same("conversations", conversations, await all((cursor) => after.scanConversations({}, 500, cursor, context)));
	for (const conversation of conversations) {
		const query = { conversationId: conversation.id, order: "ascending" as const };
		const entries = await all((cursor) => before.scanEntries(query, 500, cursor, context));
		same(
			`entries of ${conversation.id}`,
			entries,
			await all((cursor) => after.scanEntries(query, 500, cursor, context)),
		);
		for (const entry of entries) {
			const [a, b] = [await before.entry(entry.id, context), await after.entry(entry.id, context)];
			if (a === undefined || b === undefined || b.commitSeq !== mapSeq(a.commitSeq))
				throw new Error(`entry ${entry.id}'s commit seq differs after the conversion`);
		}
		same(
			`head marker of ${conversation.id}`,
			await before.findLatestHeadMarker(conversation.id, undefined, context),
			await after.findLatestHeadMarker(conversation.id, undefined, context),
		);
	}
	const tasks = await all((cursor) => before.scanTasks({}, 500, cursor, context));
	same("tasks", tasks, await all((cursor) => after.scanTasks({}, 500, cursor, context)));
	same(
		"submissions",
		await all((cursor) => before.scanSubmissions({}, 500, cursor, context)),
		await all((cursor) => after.scanSubmissions({}, 500, cursor, context)),
	);
	const record = (value: DocumentRecord | undefined) =>
		value === undefined
			? undefined
			: {
					...value,
					createdAt: mapSeq(value.createdAt),
					...(value.retiredAt === undefined ? {} : { retiredAt: mapSeq(value.retiredAt) }),
				};
	const scopes: DocumentRecord["scope"][] = [
		{ kind: "session" },
		...conversations.map((value) => ({ kind: "conversation" as const, conversationId: value.id })),
		...tasks.map((value) => ({ kind: "task" as const, taskId: value.id })),
	];
	for (const scope of scopes) {
		const query = { scope, at: "current" as const };
		const current = await all((cursor) => before.scanDocuments(query, 500, cursor, context));
		same(
			`documents of ${JSON.stringify(scope)}`,
			current.map(record),
			await all((cursor) => after.scanDocuments(query, 500, cursor, context)),
		);
		for (const document of current) {
			const [a, b] = [
				await before.document(document.id, "current", context),
				await after.document(document.id, "current", context),
			];
			same(`document ${document.id}`, a?.value, b?.value);
			same(`document ${document.id}'s version`, a?.version, b?.version);
		}
	}
	// Every document's record, retired ones included, and each rewindable one at each of its kept revisions.
	const db = new DatabaseSync(oldPath, { readOnly: true });
	try {
		const rows = db.prepare("SELECT id, record FROM documents ORDER BY id").all() as Row[];
		const kept = db
			.prepare("SELECT document_id, seq FROM document_revisions ORDER BY document_id, seq")
			.all() as Row[];
		for (const row of rows) {
			const old = JSON.parse(String(row.record)) as DocumentRecord;
			if (old.scope.kind !== "conversation" || old.history !== "rewindable") continue;
			for (const revision of kept.filter((each) => each.document_id === row.id)) {
				const seq = Number(revision.seq) as Seq;
				const [a, b] = [
					await before.document(old.id, seq, context),
					await after.document(old.id, mapSeq(seq) as Seq, context),
				];
				same(`document ${old.id} at seq ${seq}`, [record(a?.record), a?.value], [b?.record, b?.value]);
			}
		}
	} finally {
		db.close();
	}
}

/** Every item of a paged scan. */
async function all<T>(page: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
	const items: T[] = [];
	let cursor: Cursor | undefined;
	do {
		const result = await page(cursor);
		items.push(...result.items);
		cursor = result.next;
	} while (cursor !== undefined);
	return items;
}
