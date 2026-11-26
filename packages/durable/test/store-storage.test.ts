// StoreStorage (slice 6b §2): Durable's storage conformance suite on SQLite `:memory:` and across reopen, then what is
// its own: claims and close, owners sharing a store, the store's semantics for a refused commit, the allocator, and
// conversation deletion as erasure (no row left, through the outbox and archives, the conversations table's version 2).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
	applyBatch,
	type ChordStore,
	createHost,
	defineFacet,
	defineState,
	importStore,
	int,
	local,
	method,
	obj,
	openStore,
	type Step,
	type Store,
	StoreOwnerTables,
	sqliteBackend,
	str,
} from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT, withTelemetry } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { describe, expect, it } from "vitest";
import { StorageRequestError } from "../src/errors.ts";
import { idFromNumber } from "../src/ids.ts";
import { type CompactionResult, createRegistry, Harness, LiveDoc, type Tx } from "../src/index.ts";
import { SessionImpl } from "../src/session/session.ts";
import { StoreStorage } from "../src/storage/store/index.ts";
import { ConversationsV1 } from "../src/storage/store/tables.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";
import type {
	CommitResult,
	ConversationId,
	DocumentId,
	EntryId,
	Id,
	Seq,
	Storage,
	StorageWrite,
	SubmissionId,
	TaskId,
} from "../src/types.ts";
import { ROOT_CONVERSATION_ID } from "../src/types.ts";
import { openStoreStorage } from "./store-storage-support.ts";

const context = BACKGROUND_CONTEXT;
/** A storage that closes and reopens its store file after every commit (Durable's reopen harness). */
class ReopeningStorage implements Storage {
	readonly deletesConversations = true;
	#current: Storage;
	readonly #path: string;
	#closed = false;

	constructor(current: Storage, path: string) {
		this.#current = current;
		this.#path = path;
	}

	async commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		commitContext: Context,
	): Promise<CommitResult> {
		if (this.#closed) return this.#current.commit(batches, receive, commitContext);
		try {
			return await this.#current.commit(batches, receive, commitContext);
		} finally {
			await this.#current.close(context);
			this.#current = await openStoreStorage(this.#path);
		}
	}

	mintId<I extends Id<string>>(): Promise<I> {
		return this.#current.mintId<I>();
	}
	conversation: Storage["conversation"] = (id, c) => this.#current.conversation(id, c);
	scanConversations: Storage["scanConversations"] = (q, l, cursor, c) =>
		this.#current.scanConversations(q, l, cursor, c);
	entry(id: EntryId, c: Context): ReturnType<Storage["entry"]>;
	entry(conversationId: ConversationId, id: EntryId, c: Context): ReturnType<Storage["entry"]>;
	entry(first: EntryId | ConversationId, second: EntryId | Context, third?: Context) {
		if (third === undefined) return this.#current.entry(idFromNumber<EntryId>(first), second as Context);
		return this.#current.entry(idFromNumber<ConversationId>(first), second as EntryId, third);
	}
	findLatestHeadMarker: Storage["findLatestHeadMarker"] = (id, at, c) => this.#current.findLatestHeadMarker(id, at, c);
	scanEntries: Storage["scanEntries"] = (q, l, cursor, c) => this.#current.scanEntries(q, l, cursor, c);
	task: Storage["task"] = (id, c) => this.#current.task(id, c);
	scanTasks: Storage["scanTasks"] = (q, l, cursor, c) => this.#current.scanTasks(q, l, cursor, c);
	submission: Storage["submission"] = (id, c) => this.#current.submission(id, c);
	scanSubmissions: Storage["scanSubmissions"] = (q, l, cursor, c) => this.#current.scanSubmissions(q, l, cursor, c);
	submissionByRequest: Storage["submissionByRequest"] = (id, request, c) =>
		this.#current.submissionByRequest(id, request, c);
	findDocument: Storage["findDocument"] = (address, at, c) => this.#current.findDocument(address, at, c);
	document: Storage["document"] = (id, at, c) => this.#current.document(id, at, c);
	scanDocuments: Storage["scanDocuments"] = (q, l, cursor, c) => this.#current.scanDocuments(q, l, cursor, c);

	async close(closeContext: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#current.close(closeContext);
	}
}

registerStorageConformance({ describe, expect, it }, "StoreStorage", async (use) => {
	const storage = await openStoreStorage(":memory:");
	try {
		await use(storage);
	} finally {
		await storage.close(context);
	}
});

registerStorageConformance({ describe, expect, it }, "StoreStorage across reopen", async (use) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-store-conformance-"));
	const path = join(directory, "store.sqlite");
	const storage = new ReopeningStorage(await openStoreStorage(path), path);
	try {
		await use(storage);
	} finally {
		await storage.close(context);
		await rm(directory, { recursive: true, force: true });
	}
});

/** A store on `:memory:`. */
async function memoryStore() {
	return openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
}

describe("claims and close", () => {
	it("refuse a second StoreStorage on one owner until the first closed; two owners share a store", async () => {
		const store = await memoryStore();
		const first = await StoreStorage.open(store, "harness", context);
		await expect(StoreStorage.open(store, "harness", context)).rejects.toMatchObject({
			code: "invalid",
			reason: "args",
		});
		const other = await StoreStorage.open(store, "other", context);
		await commitWrites(first, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		expect(await other.conversation(ROOT_CONVERSATION_ID, context)).toBeUndefined();
		await first.close(context);
		await expect(first.conversation(ROOT_CONVERSATION_ID, context)).rejects.toThrow("StoreStorage is closed");
		const reopened = await StoreStorage.open(store, "harness", context);
		expect(await reopened.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });
		await store.close(context);
	});

	it("waits at close for its calls underway, then releases its claims", async () => {
		const store = await memoryStore();
		const storage = await StoreStorage.open(store, "harness", context);
		const commit = commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		const closing = storage.close(context);
		await commit;
		await closing;
		await StoreStorage.open(store, "harness", context);
		await store.close(context);
	});
});

describe("the store's semantics (D4)", () => {
	it("a refused Durable commit rejects with Durable's message and keeps the store usable", async () => {
		const store = await memoryStore();
		const storage = await StoreStorage.open(store, "harness", context);
		const root = { type: "conversation", value: { id: ROOT_CONVERSATION_ID } } as const;
		await commitWrites(storage, [root], context);
		await expect(commitWrites(storage, [root], context)).rejects.toThrow("ID 1 already belongs to conversation");
		const entry = {
			id: idFromNumber<EntryId>(await storage.mintId()),
			conversationId: ROOT_CONVERSATION_ID,
			kind: "m",
		};
		await commitWrites(storage, [{ type: "entry", value: entry }], context);
		expect((await storage.entry(entry.id, context))?.entry).toEqual(entry);
		await store.close(context);
	});

	it("raises the allocator above every id it holds when it opens (a store built by import)", async () => {
		const store = await memoryStore();
		const storage = await StoreStorage.open(store, "harness", context);
		const entry = { id: idFromNumber<EntryId>(500), conversationId: ROOT_CONVERSATION_ID, kind: "m" };
		await commitWrites(
			storage,
			[
				{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
				{ type: "entry", value: entry },
			],
			context,
		);
		expect(await storage.mintId()).toBe(501);
		await store.close(context);
	});
});

const MemoDoc = defineState("memo", {
	schema: obj({ m: int() }),
	version: 1,
	initial: () => ({ m: 1 }),
	persist: true,
	checkpointWhen: () => true,
});

const Memo = local("app.memo", { version: 1, params: {}, members: { memo: obj({ m: int() }), set: method() } });

/** A store on `:memory:` with an outbox from its first commit, and Durable's storage in it. */
async function recorded() {
	const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context, {
		outbox: true,
	})) as ChordStore;
	const storage = await StoreStorage.open(store, "harness", context);
	await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
	return { store, storage };
}

/** Rewindable history, a retired latest document, a create-plus-retire and a change-plus-retire. */
async function history(storage: Storage): Promise<{ readonly rewindable: DocumentId; readonly seqs: Seq[] }> {
	const scope = { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } as const;
	const rewindable = await storage.mintId<DocumentId>();
	const latest = await storage.mintId<DocumentId>();
	const empty = await storage.mintId<DocumentId>();
	const seqs: Seq[] = [];
	const base = (n: number) => ({ kind: "base", version: 1, value: { n } }) as const;
	seqs.push(
		await commitWrites(
			storage,
			[
				{
					type: "document.create",
					record: { id: rewindable, kind: "r", scope, history: "rewindable", fork: "asOf" },
					content: base(0),
				},
				{
					type: "document.create",
					record: { id: latest, kind: "l", scope, history: "latest", fork: "current" },
					content: base(0),
				},
			],
			context,
		),
	);
	seqs.push(
		await commitWrites(
			storage,
			[{ type: "document.change", id: rewindable, content: { kind: "delta", version: 1, ops: [["s", ["n"], 1]] } }],
			context,
		),
	);
	seqs.push(
		await commitWrites(
			storage,
			[
				{ type: "document.change", id: latest, content: { kind: "delta", version: 1, ops: [["s", ["n"], 2]] } },
				{ type: "document.retire", id: latest },
				{ type: "document.create", record: { id: empty, kind: "e", scope: { kind: "session" } }, content: base(3) },
				{ type: "document.retire", id: empty },
			],
			context,
		),
	);
	return { rewindable, seqs };
}

describe("archives and batches of Durable data", () => {
	it("export and import keep rewindable history, retired records and Chord's own data: reads at a point agree", async () => {
		const { store, storage } = await recorded();
		const { rewindable, seqs } = await history(storage);
		// Chord's own data in the same store: an object's persisted document.
		const host = createHost({ store, onError: () => {} });
		const facet = defineFacet((h) =>
			h.serve(Memo, (_, self) => {
				const memo = self.state(MemoDoc);
				return {
					memo,
					set: async (ctx) => {
						await memo.change((draft) => {
							draft.m = 2;
						}, ctx);
						return null;
					},
				};
			}),
		);
		await host.load([{ name: "app", facet }], context);
		await (await host.get(Memo, {}, context)).set(context);
		await host.close(context);
		const parts = [];
		for await (const part of store.export(context)) parts.push(part);
		expect(parts.filter((part) => part.kind === "document.create").map(({ record }) => record.owner)).toContain(
			"app.memo",
		);
		const copy = await importStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), parts, context);
		const imported = await StoreStorage.open(copy, "harness", context);
		for (const at of [seqs[0]!, seqs[1]!, "current" as const]) {
			expect(await imported.document(rewindable, at, context)).toEqual(
				await storage.document(rewindable, at, context),
			);
		}
		const scope = { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } as const;
		const at = seqs[1]!;
		expect(await imported.scanDocuments({ scope, at }, 10, undefined, context)).toEqual(
			await storage.scanDocuments({ scope, at }, 10, undefined, context),
		);
		const again = [];
		for await (const part of copy.export(context)) again.push(part);
		expect(again).toEqual(parts);
		expect(await imported.mintId()).toBe(await storage.mintId());
		await copy.close(context);
		await store.close(context);
	});

	it("an outbox of Durable commits replayed into an empty store gives the same archive (create-plus-retire included)", async () => {
		const { store, storage } = await recorded();
		await history(storage);
		const commits = await (store as ChordStore).outbox!.read(0, 1_000, context);
		const replica = (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ChordStore;
		await applyBatch(replica, commits, context);
		const exported = async (from: Store) => {
			const parts = [];
			for await (const part of from.export(context)) parts.push(part);
			return parts;
		};
		expect(await exported(replica)).toEqual(await exported(store));
		await replica.close(context);
		await store.close(context);
	});
});

/**
 * A conversation forked from the root with a rewindable document changed twice, a task with its own document, an
 * entry with a head marker and a submission, then deleted; returns its ids.
 */
async function deleted(storage: Storage) {
	const doomed = await storage.mintId<ConversationId>();
	const [first, marker] = [await storage.mintId<EntryId>(), await storage.mintId<EntryId>()];
	const task = await storage.mintId<TaskId<JsonValue>>();
	const submission = await storage.mintId<SubmissionId>();
	const [notes, taskNotes] = [await storage.mintId<DocumentId>(), await storage.mintId<DocumentId>()];
	const scope = { kind: "conversation", conversationId: doomed } as const;
	const delta = (text: string) =>
		({
			type: "document.change",
			id: notes,
			content: { kind: "delta", version: 1, ops: [["s", ["text"], text]] },
		}) as const;
	await commitWrites(
		storage,
		[
			{ type: "conversation", value: { id: doomed, parent: { conversationId: ROOT_CONVERSATION_ID, at: first } } },
			{ type: "entry", value: { id: first, conversationId: doomed, kind: "m" } },
			{ type: "entry", value: { id: marker, conversationId: doomed, kind: "s", head: first } },
			{
				type: "task",
				value: {
					id: task,
					conversationId: doomed,
					kind: "t",
					version: 1,
					input: null,
					state: { status: "terminal", outcome: { status: "aborted" } },
					background: false,
					abortRequested: false,
				},
			},
			{
				type: "submission",
				value: { id: submission, conversationId: doomed, type: "write", status: "unanswered", reason: "deleted" },
			},
			{
				type: "document.create",
				record: { id: notes, kind: "notes", scope, history: "rewindable", fork: "asOf" },
				content: { kind: "base", version: 1, value: { text: "secret" } },
			},
			{
				type: "document.create",
				record: { id: taskNotes, kind: "notes", scope: { kind: "task", taskId: task } },
				content: { kind: "base", version: 1, value: { text: "task secret" } },
			},
		],
		context,
	);
	await commitWrites(storage, [delta("more secret")], context);
	await commitWrites(storage, [delta("most secret"), { type: "document.retire", id: notes }], context);
	await commitWrites(storage, [{ type: "conversation.delete", id: doomed }], context);
	return { doomed, notes, taskNotes };
}

/** Every row of every table of `store` (its outbox aside) whose text holds `needle`. */
async function holding(store: ChordStore, needle: string): Promise<string[]> {
	return store.read(async (executor) => {
		const tables = await executor.all<{ readonly name: string }>(
			"SELECT name FROM sqlite_schema WHERE type = 'table' AND name <> 'chord_outbox'",
		);
		const found: string[] = [];
		for (const { name } of tables) {
			const rows = await executor.all<object>(`SELECT * FROM "${name}"`);
			for (const row of rows) if (JSON.stringify(row).includes(needle)) found.push(name);
		}
		return found;
	}, context);
}

describe("conversation deletion (real erasure)", () => {
	it("leaves no row of a deleted conversation, its rewindable revisions included; its ids stay claimed", async () => {
		const { store, storage } = await recorded();
		const { doomed, notes, taskNotes } = await deleted(storage);
		expect(await holding(store, "secret")).toEqual([]);
		const stored = await store.read(
			(executor) =>
				executor.all<{ readonly id: number }>(
					"SELECT id FROM chord_documents WHERE id IN (?, ?) UNION ALL SELECT document_id FROM chord_revisions WHERE document_id IN (?, ?)",
					notes,
					taskNotes,
					notes,
					taskNotes,
				),
			context,
		);
		expect(stored).toEqual([]);
		for (const table of ["conversations", "entries", "entry_heads", "tasks", "submissions"]) {
			const rows = await store.read(
				(executor) => executor.all(`SELECT * FROM "harness:${table}" WHERE id <> ?`, ROOT_CONVERSATION_ID),
				context,
			);
			expect(rows).toEqual([]);
		}
		await expect(commitWrites(storage, [{ type: "conversation", value: { id: doomed } }], context)).rejects.toThrow(
			`ID ${doomed} already belongs to conversation`,
		);
		await store.close(context);
	});

	it("travels as writes: a replayed outbox and an export agree, and a trim past it erases it from the outbox", async () => {
		const { store, storage } = await recorded();
		await history(storage);
		await deleted(storage);
		const exported = async (from: Store) => {
			const parts = [];
			for await (const part of from.export(context)) parts.push(part);
			return parts;
		};
		const commits = await store.outbox!.read(0, 1_000, context);
		const deletion = commits.at(-1)!.writes.map(({ kind }) => kind);
		expect(deletion.filter((kind) => kind === "document.purge")).toHaveLength(2);
		expect(deletion.filter((kind) => kind === "deleteWhere")).toHaveLength(4);
		expect(deletion.at(-1)).toBe("delete");
		// The commits before the deletion keep the content until the outbox is trimmed past it.
		expect(JSON.stringify(commits)).toContain("secret");
		const replica = (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ChordStore;
		await applyBatch(replica, commits, context);
		const archive = await exported(store);
		expect(await exported(replica)).toEqual(archive);
		expect(JSON.stringify(archive)).not.toContain("secret");
		const copy = await importStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), archive, context);
		expect(await exported(copy)).toEqual(archive);
		await store.outbox!.trim(store.lastSeq, context);
		expect(await holding(store, "secret")).toEqual([]);
		expect(await store.outbox!.read(store.lastSeq, 1_000, context)).toEqual([]);
		for (const each of [copy, replica, store]) await each.close(context);
	});

	it("a store of the conversations table's version 1 opens migrated: the fork query finds its rows", async () => {
		const store = (await memoryStore()) as ChordStore;
		const claimant = { label: "version 1" };
		const tables = new StoreOwnerTables(store, "harness", claimant);
		const conversations = tables.declare(ConversationsV1);
		await tables.prepare(context);
		const fork = idFromNumber<ConversationId>(10);
		const nested = idFromNumber<ConversationId>(11);
		const at = idFromNumber<EntryId>(5);
		const records = [
			{ id: ROOT_CONVERSATION_ID },
			{ id: fork, parent: { conversationId: ROOT_CONVERSATION_ID, at } },
			{ id: nested, parent: { conversationId: fork, at } },
		];
		const puts = records.map((record) => {
			const row = conversations.encode({ id: record.id, owner_conversation_id: 0, owner_task_id: 0, record });
			return { order: "write", apply: async (step: Step) => [await conversations.put(step, row)] } as const;
		});
		await store.commit(puts, { admit: () => true, adopt: () => {} }, context);
		store.claims.release(claimant);
		const storage = await StoreStorage.open(store, "harness", context);
		const ids = async (query: Parameters<Storage["scanConversations"]>[0]) =>
			(await storage.scanConversations(query, 10, undefined, context)).items.map(({ id }) => id);
		expect(await ids({ parentConversationId: ROOT_CONVERSATION_ID })).toEqual([fork]);
		expect(await ids({ parentConversationId: fork })).toEqual([nested]);
		expect(store.table("harness:conversations")).toMatchObject({ version: 2, state: "ready" });
		await store.close(context);
	});
});

describe("head markers (the entry_heads table)", () => {
	it("a head entry is found after reopen, in an imported archive and in a replayed outbox", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-store-heads-"));
		const path = join(directory, "store.sqlite");
		const open = async () =>
			(await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context, { outbox: true })) as ChordStore;
		let store = await open();
		let storage = await StoreStorage.open(store, "harness", context);
		await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		const entry = async (head?: EntryId): Promise<EntryId> => {
			const id = await storage.mintId<EntryId>();
			const value = { id, conversationId: ROOT_CONVERSATION_ID, kind: "k", data: {}, ...(head ? { head } : {}) };
			await commitWrites(storage, [{ type: "entry", value }], context);
			return id;
		};
		const first = await entry();
		const marker = await entry(first);
		await entry();
		/** The newest head marker, and the one at or before the first entry (none). */
		const heads = async (of: Storage) => [
			(await of.findLatestHeadMarker(ROOT_CONVERSATION_ID, undefined, context))?.id,
			(await of.findLatestHeadMarker(ROOT_CONVERSATION_ID, first, context))?.id,
		];
		expect(await heads(storage)).toEqual([marker, undefined]);
		await storage.close(context);
		await store.close(context);
		store = await open();
		storage = await StoreStorage.open(store, "harness", context);
		expect(await heads(storage)).toEqual([marker, undefined]);
		const parts = [];
		for await (const part of store.export(context)) parts.push(part);
		expect(parts.filter((part) => part.kind === "put" && part.table === "harness:entry_heads")).toEqual([
			expect.objectContaining({ row: { id: marker, conversation_id: ROOT_CONVERSATION_ID } }),
		]);
		const copy = await importStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), parts, context);
		expect(await heads(await StoreStorage.open(copy, "harness", context))).toEqual([marker, undefined]);
		const replica = (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ChordStore;
		await applyBatch(replica, await store.outbox!.read(0, 1_000, context), context);
		expect(await heads(await StoreStorage.open(replica, "harness", context))).toEqual([marker, undefined]);
		for (const each of [copy, replica, store]) await each.close(context);
		await rm(directory, { recursive: true, force: true });
	});
});

describe("reads (slice 6b §1.4, §2.4)", () => {
	it("a request error inside a multi-query read rejects that read only; the store goes on", async () => {
		const { store, storage } = await recorded();
		await expect(
			storage.scanEntries({ conversationId: idFromNumber<ConversationId>(999) }, 10, undefined, context),
		).rejects.toBeInstanceOf(StorageRequestError);
		await expect(storage.document(idFromNumber<DocumentId>(999), "current", context)).resolves.toBeUndefined();
		expect(await storage.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });
		await store.close(context);
	});
});

describe("commits (slice 6b §1.3, §2.5)", () => {
	it("publishes each commit of a Session inside the attached host's batch, and plainly without a host", async () => {
		const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ChordStore;
		const storage = await StoreStorage.open(store, "harness", context);
		const plain: boolean[] = [];
		storage.publishing(() => plain.push(store.batch === undefined), context);
		expect(plain).toEqual([true]);
		const host = createHost({ store, onError: () => {} });
		const session = new SessionImpl(storage);
		const running: boolean[] = [];
		session.followCommits(() => {
			running.push(store.batch!.running);
		});
		await session.commitWith((tx) => tx.createRootConversation(), context);
		await Promise.all([
			session.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "a" }), context),
			session.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "b" }), context),
		]);
		expect(running).toEqual([true, true, true]);
		await session.close(context);
		await host.close(context);
		await store.close(context);
	});

	it("counts four statements for an entry append and for a delta, with a host attached", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const span = await telemetry.startSpan({ name: "test" }, (each) => each);
		const metered = withTelemetry(span, context);
		const counts = (): number =>
			telemetry
				.getMetrics()
				.filter(({ name }) => name === "chord.store.statements")
				.reduce((total, { value }) => total + value, 0);
		const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context)) as ChordStore;
		const host = createHost({ store, onError: () => {} });
		const storage = await StoreStorage.open(store, "harness", context);
		await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		const entry = {
			id: idFromNumber<EntryId>(await storage.mintId()),
			conversationId: ROOT_CONVERSATION_ID,
			kind: "m",
		};
		const before = counts();
		await storage.commit([[{ type: "entry", value: entry }]], () => {}, metered);
		const appended = counts() - before;
		const id = await storage.mintId<DocumentId>();
		const record = { id, kind: "s", scope: { kind: "session" } } as const;
		await commitWrites(
			storage,
			[{ type: "document.create", record, content: { kind: "base", version: 1, value: { n: 0 } } }],
			context,
		);
		const changed = counts();
		await commitWrites(
			storage,
			[{ type: "document.change", id, content: { kind: "delta", version: 1, ops: [["s", ["n"], 1]] } }],
			metered,
		);
		expect([appended, counts() - changed]).toEqual([4, 4]);
		await host.close(context);
		await store.close(context);
	});
});

describe("Durable's views as Chord sources on the store (slice 6b §3)", () => {
	const Chat = local("app.chat", {
		version: 1,
		params: {},
		members: { entries: int(), note: method(obj({ kind: str() })) },
	});

	it("a derive over the conversation view and the task graph: one frame per Durable commit, both views in one batch", async () => {
		const store = await memoryStore();
		const host = createHost({ store, onError: () => {} });
		let computes = 0;
		const facet = defineFacet((h) =>
			h.serve(Chat, (_, self) => {
				const harness = self.open(
					async (open) => {
						const opened = await Harness.open(
							await StoreStorage.open(store, Chat.name, open),
							{ models: createModels(), registry: createRegistry() },
							open,
						);
						await opened.root(open);
						return opened;
					},
					(h, _reason, close) => h.close(close),
				);
				const view = self.follow((observer, ctx) =>
					harness.value.observeConversation(ROOT_CONVERSATION_ID, observer, ctx),
				);
				const graph = self.follow((observer, ctx) => harness.value.observeTaskGraph(observer, ctx));
				const entries = self.derive([view, graph], ([v]) => {
					computes++;
					return v.entries.length;
				});
				return {
					entries,
					note: async ({ kind }, ctx) => {
						const root = await harness.value.conversation(ROOT_CONVERSATION_ID, ctx);
						await root!.submit({ type: "write", entry: { kind } }, ctx);
						return null;
					},
				};
			}),
		);
		await host.load([{ name: "app", facet }], context);
		const chat = await host.get(Chat, {}, context);
		const calls: unknown[] = [];
		const watch = await chat.entries.watch(context);
		watch.start(async (call) => void calls.push(call.kind === "value" ? call.value : call.kind));
		const before = computes;
		await chat.note({ kind: "test.note" }, context);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(chat.entries.value).toBeGreaterThan(0);
		expect(calls).toEqual([chat.entries.value]);
		expect(computes - before).toBe(1);
		await host.close(context);
		await store.close(context);
	});

	it("a deferred Durable commit, then an immediate one, reach the followed document in order", async () => {
		const store = await memoryStore();
		const host = createHost({ store, onError: () => {} });
		const Live = local("app.live", {
			version: 1,
			params: {},
			members: { n: int(), bump: method() },
		});
		/** A commit setting the root's `LiveDoc` failure note to `value`. */
		const set = (value: number) => async (tx: Tx) => {
			(await tx.doc(LiveDoc, ROOT_CONVERSATION_ID)).compactionFailure = {
				taskId: idFromNumber<TaskId<CompactionResult>>(1),
				trigger: "manual",
				error: String(value),
			};
		};
		const facet = defineFacet((h) =>
			h.serve(Live, (_, self) => {
				const harness = self.open(
					async (open) => {
						const opened = await Harness.open(
							await StoreStorage.open(store, Live.name, open),
							{ models: createModels(), registry: createRegistry() },
							open,
						);
						await (await opened.root(open)).commit(set(0), open);
						return opened;
					},
					(h, _reason, close) => h.close(close),
				);
				const live = self.follow((observer, ctx) =>
					harness.value.observeDoc(LiveDoc, ROOT_CONVERSATION_ID, observer, ctx),
				);
				return {
					n: self.derive([live], ([value]) => Number(value.compactionFailure?.error ?? -1)),
					bump: async (ctx) => {
						const root = (await harness.value.conversation(ROOT_CONVERSATION_ID, ctx))!;
						await root.commit(set(1), ctx, { persistence: { kind: "deferred", withinMs: 10_000 } });
						await root.commit(set(2), ctx);
						return null;
					},
				};
			}),
		);
		await host.load([{ name: "app", facet }], context);
		const live = await host.get(Live, {}, context);
		const seen: unknown[] = [];
		const watch = await live.n.watch(context);
		watch.start(async (call) => void seen.push(call.kind === "value" ? call.value : call.kind));
		await live.bump(context);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(live.n.value).toBe(2);
		expect(seen.at(-1)).toBe(2);
		await host.close(context);
		await store.close(context);
	});
});

describe("review regressions", () => {
	it('a head-marker entry whose kind is "refused" is returned, not taken for a request error', async () => {
		const storage = await openStoreStorage(":memory:");
		await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
		const first = await storage.mintId<EntryId>();
		const marker = await storage.mintId<EntryId>();
		await commitWrites(
			storage,
			[
				{ type: "entry", value: { id: first, conversationId: ROOT_CONVERSATION_ID, kind: "message" } },
				{
					type: "entry",
					value: { id: marker, conversationId: ROOT_CONVERSATION_ID, kind: "refused", head: first },
				},
			],
			context,
		);
		expect((await storage.findLatestHeadMarker(ROOT_CONVERSATION_ID, undefined, context))?.id).toBe(marker);
		const page = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 10, undefined, context);
		expect(page.items.map(({ kind }) => kind)).toEqual(["refused", "message"]);
		await storage.close(context);
	});
});

describe("GC", () => {
	it("a closed StoreStorage is collected while its store stays open", async () => {
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc") as () => void;
		const store = await memoryStore();
		const opened = async (): Promise<WeakRef<StoreStorage>> => {
			const storage = await StoreStorage.open(store, "harness", context);
			await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
			await storage.close(context);
			return new WeakRef(storage);
		};
		const ref = await opened();
		for (let round = 0; round < 10 && ref.deref() !== undefined; round++) {
			await new Promise((resolve) => setImmediate(resolve));
			gc();
		}
		expect(ref.deref()).toBeUndefined();
		await store.close(context);
	});
});
