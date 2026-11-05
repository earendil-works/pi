// SqliteStorage.commit() over its batch path (src/storage/sqlite/commit.ts): random batch calls compared against the
// memory reference storage, and the statement count of a call, which must not grow with its batches.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import { openNodeSqliteDatabase } from "../src/storage/sqlite/node.ts";
import { SqliteStorage } from "../src/storage/sqlite/storage.ts";
import type {
	ConversationId,
	DocumentContent,
	DocumentCreate,
	DocumentId,
	EntryId,
	Seq,
	Storage,
	StorageWrite,
	SubmissionId,
	TaskId,
	TaskRecord,
} from "../src/types.ts";
import { ROOT_CONVERSATION_ID } from "../src/types.ts";

const context = BACKGROUND_CONTEXT;
const openStorages = new Set<Storage>();
const directories = new Set<string>();

afterEach(async () => {
	for (const storage of openStorages) await storage.close(context);
	openStorages.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

/** A SQLite database in a fresh directory, optionally seen through `wrap`. */
async function openDatabase(): Promise<SqliteDatabase> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-sqlite-commit-"));
	directories.add(directory);
	return openNodeSqliteDatabase(join(directory, "storage.sqlite"));
}

async function openStorage(db: SqliteDatabase): Promise<SqliteStorage> {
	const storage = await SqliteStorage.open(db);
	openStorages.add(storage);
	return storage;
}

/** Deterministic pseudo-random numbers (mulberry32), so a failing seed reproduces. */
function random(seed: number) {
	let state = seed >>> 0;
	const next = (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const int = (max: number): number => Math.floor(next() * max);
	const pick = <T>(values: readonly T[]): T => values[int(values.length)]!;
	const chance = (p: number): boolean => next() < p;
	return { int, pick, chance };
}

type Random = ReturnType<typeof random>;

/** What the generator has proposed so far: the pools later writes reuse, valid or not. */
type World = {
	nextId: number;
	readonly conversations: ConversationId[];
	readonly entries: EntryId[];
	readonly tasks: TaskId<JsonValue>[];
	readonly submissions: SubmissionId[];
	readonly documents: { readonly id: DocumentId; readonly record: DocumentCreate }[];
	readonly seqs: Seq[];
	/**
	 * The documents the current call created or changed, with the version it gave them last, and the addresses it
	 * retired: later batches of the call target them, so batches depend on the ones before them in the same call.
	 */
	readonly call: Map<DocumentId, number>;
	readonly retired: DocumentCreate[];
};

const TASK_STATES = [
	{ status: "pending", checkpoint: { phase: "ready" } },
	{ status: "running", checkpoint: { phase: "ready" } },
	{ status: "terminal", outcome: { kind: "returned", value: 1 } },
] as const;

function fresh(world: World): number {
	return world.nextId++;
}

/** Any ID the world knows, of any table: a write reusing it is often refused. */
function anyId(world: World, rng: Random): number {
	const pools: readonly (readonly number[])[] = [
		world.conversations,
		world.entries,
		world.tasks,
		world.submissions,
		world.documents.map((document) => document.id),
	].filter((pool) => pool.length > 0);
	return pools.length === 0 ? fresh(world) : rng.pick(rng.pick(pools));
}

function randomAddress(world: World, rng: Random, id: DocumentId): DocumentCreate {
	const kind = rng.pick(["a", "b"]);
	const key = rng.chance(0.5) ? undefined : rng.pick(["x", "y"]);
	const base = { id, kind, ...(key === undefined ? {} : { key }) };
	const scope = rng.int(3);
	if (scope === 0) return { ...base, scope: { kind: "session" } };
	if (scope === 1 && world.tasks.length > 0)
		return { ...base, scope: { kind: "task", taskId: rng.pick(world.tasks) } };
	const conversationId = rng.pick(world.conversations);
	return rng.chance(0.5)
		? { ...base, scope: { kind: "conversation", conversationId }, history: "latest", fork: "current" }
		: { ...base, scope: { kind: "conversation", conversationId }, history: "rewindable", fork: "asOf" };
}

function randomContent(rng: Random, version: number): DocumentContent {
	return rng.chance(0.4)
		? { kind: "base", version: rng.chance(0.8) ? version : version + 1, value: { n: rng.int(100), at: rng.int(5) } }
		: { kind: "delta", version: rng.chance(0.85) ? version : version + 1, ops: [["s", ["n"], rng.int(100)]] };
}

/** One random write, biased toward valid ones, with `reference` telling which documents are live. */
async function randomWrite(world: World, rng: Random, reference: MemoryStorage): Promise<StorageWrite> {
	switch (rng.int(9)) {
		case 0: {
			const id = rng.chance(0.85)
				? idFromNumber<ConversationId>(fresh(world))
				: (anyId(world, rng) as ConversationId);
			world.conversations.push(id);
			return { type: "conversation", value: { id } };
		}
		case 1:
		case 2: {
			const id = rng.chance(0.9) ? idFromNumber<EntryId>(fresh(world)) : (anyId(world, rng) as EntryId);
			world.entries.push(id);
			const head = rng.chance(0.2) && world.entries.length > 0 ? { head: rng.pick(world.entries) } : {};
			return {
				type: "entry",
				value: { id, conversationId: rng.pick(world.conversations), kind: "note", data: rng.int(1000), ...head },
			};
		}
		case 3: {
			const id =
				world.tasks.length > 0 && rng.chance(0.6)
					? rng.pick(world.tasks)
					: rng.chance(0.9)
						? idFromNumber<TaskId<JsonValue>>(fresh(world))
						: (anyId(world, rng) as TaskId<JsonValue>);
			world.tasks.push(id);
			const task = {
				id,
				conversationId: rng.pick(world.conversations),
				kind: rng.pick(["t.one", "t.two"]),
				version: 1,
				input: { value: rng.int(10) },
				state: rng.pick(TASK_STATES),
				background: rng.chance(0.5),
				abortRequested: rng.chance(0.2),
			} as TaskRecord<JsonValue, JsonValue, JsonValue>;
			return { type: "task", value: task };
		}
		case 4: {
			const id =
				world.submissions.length > 0 && rng.chance(0.5)
					? rng.pick(world.submissions)
					: rng.chance(0.9)
						? idFromNumber<SubmissionId>(fresh(world))
						: (anyId(world, rng) as SubmissionId);
			world.submissions.push(id);
			// One request ID per submission: storages differ on duplicates, which the Session never writes.
			const requestId = rng.chance(0.5) ? { requestId: `r${id}` } : {};
			return {
				type: "submission",
				value: { id, conversationId: rng.pick(world.conversations), type: "input", status: "queued", ...requestId },
			};
		}
		case 5: {
			const id = rng.chance(0.9) ? idFromNumber<DocumentId>(fresh(world)) : (anyId(world, rng) as DocumentId);
			// Often at an address the call retired or another document has: the address's live count decides.
			const record =
				world.retired.length > 0 && rng.chance(0.5)
					? { ...rng.pick(world.retired), id }
					: world.documents.length > 0 && rng.chance(0.3)
						? { ...rng.pick(world.documents).record, id }
						: randomAddress(world, rng, id);
			world.documents.push({ id, record });
			world.call.set(id, 1);
			return { type: "document.create", record, content: { kind: "base", version: 1, value: { n: 0, at: 0 } } };
		}
		case 6:
		case 7: {
			if (world.documents.length === 0) return randomWrite(world, rng, reference);
			const id =
				world.call.size > 0 && rng.chance(0.4)
					? rng.pick([...world.call.keys()])
					: (await pickDocument(rng, reference, world.documents)).id;
			if (rng.chance(0.25)) {
				const record = world.documents.find((document) => document.id === id)!.record;
				world.retired.push(record);
				world.call.delete(id);
				return { type: "document.retire", id };
			}
			const version = world.call.get(id) ?? (await reference.document(id, "current", context))?.version ?? 1;
			const content = randomContent(rng, version);
			world.call.set(id, content.version);
			return { type: "document.change", id, content };
		}
		default: {
			const sources = world.documents.filter((document) => document.record.scope.kind === "conversation");
			if (sources.length === 0) return randomWrite(world, rng, reference);
			const source = await pickDocument(rng, reference, sources);
			const id = idFromNumber<DocumentId>(fresh(world));
			const conversationId = rng.pick(world.conversations);
			const record = rng.chance(0.85)
				? ({ ...source.record, id, scope: { kind: "conversation", conversationId } } as DocumentCreate)
				: randomAddress(world, rng, id);
			world.documents.push({ id, record });
			const historical = source.record.history === "rewindable" ? 0.4 : 0.05;
			const at = world.seqs.length > 0 && rng.chance(historical) ? rng.pick(world.seqs) : "current";
			return { type: "document.copy", record, source: { id: source.id, at } };
		}
	}
}

/**
 * A document's replacement in one batch: a new incarnation at its address and its retirement, in either order, so the
 * address's current incarnation changes within the batch.
 */
async function replacement(world: World, rng: Random, reference: MemoryStorage): Promise<StorageWrite[]> {
	if (world.documents.length === 0) return [];
	const target = await pickDocument(rng, reference, world.documents);
	const id = idFromNumber<DocumentId>(fresh(world));
	const record = { ...target.record, id };
	world.documents.push({ id, record });
	world.call.set(id, 1);
	world.call.delete(target.id);
	world.retired.push(target.record);
	const pair: StorageWrite[] = [
		{ type: "document.create", record, content: { kind: "base", version: 1, value: { n: 0, at: 0 } } },
		{ type: "document.retire", id: target.id },
	];
	return rng.chance(0.5) ? pair : pair.reverse();
}

/** One of `documents`, mostly a live one (as `reference` stores it). */
async function pickDocument<T extends { readonly id: DocumentId }>(
	rng: Random,
	reference: MemoryStorage,
	documents: readonly T[],
): Promise<T> {
	if (rng.chance(0.15)) return rng.pick(documents);
	const live: T[] = [];
	for (const document of documents) {
		if ((await reference.document(document.id, "current", context)) !== undefined) live.push(document);
	}
	return live.length > 0 ? rng.pick(live) : rng.pick(documents);
}

/** A read's result, or its error's message: both storages must agree on either. */
async function settle(read: () => Promise<unknown>): Promise<unknown> {
	try {
		return { value: await read() };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** Everything a storage exposes about the world's records, at `"current"` and at `seqs`. */
async function snapshot(storage: Storage, world: World, seqs: readonly Seq[]): Promise<unknown> {
	const all = 10_000;
	const documentIds = [...new Set(world.documents.map((document) => document.id))];
	const scopes = [
		{ kind: "session" } as const,
		...world.conversations.map((conversationId) => ({ kind: "conversation", conversationId }) as const),
		...world.tasks.map((taskId) => ({ kind: "task", taskId }) as const),
	];
	return {
		conversations: (await storage.scanConversations({}, all, undefined, context)).items,
		entries: await Promise.all([...new Set(world.entries)].map((id) => settle(() => storage.entry(id, context)))),
		transcripts: await Promise.all(
			[...new Set(world.conversations)].map((conversationId) =>
				settle(() => storage.scanEntries({ conversationId, order: "ascending" }, all, undefined, context)),
			),
		),
		tasks: (await storage.scanTasks({}, all, undefined, context)).items,
		submissions: (await storage.scanSubmissions({}, all, undefined, context)).items,
		requests: await Promise.all(
			[...new Set(world.conversations)].flatMap((conversationId) =>
				[...new Set(world.submissions)].map((id) =>
					settle(() => storage.submissionByRequest(conversationId, `r${id}`, context)),
				),
			),
		),
		documents: await Promise.all(
			documentIds.flatMap((id) =>
				(["current", ...seqs] as const).map((at) => settle(() => storage.document(id, at, context))),
			),
		),
		scopes: await Promise.all(
			scopes.map((scope) => settle(() => storage.scanDocuments({ scope, at: "current" }, all, undefined, context))),
		),
		addresses: await Promise.all(
			world.documents.map(({ record }) =>
				settle(() =>
					storage.findDocument(
						{ kind: record.kind, scope: record.scope, ...(record.key === undefined ? {} : { key: record.key }) },
						"current",
						context,
					),
				),
			),
		),
	};
}

/**
 * Every row of a SQLite storage's tables, in key order: also what reads do not show, such as the revisions a
 * current-only document dropped.
 */
async function dumpTables(db: SqliteDatabase): Promise<Record<string, unknown>> {
	const tables = ["durable_metadata", "record_ids", "conversations", "entries", "tasks", "submissions", "documents"];
	const dump: Record<string, unknown> = {};
	for (const table of [...tables, "document_revisions"])
		dump[table] = await db.all(`SELECT * FROM ${table} ORDER BY 1, 2`);
	return dump;
}

/**
 * The revisions a current-only document should have dropped, which no read shows: one older than its latest base, or
 * any once it is retired.
 */
function staleRevisions(db: SqliteDatabase): Promise<unknown[]> {
	return db.all(
		`SELECT revision.document_id, revision.seq FROM document_revisions AS revision
			JOIN documents AS document ON document.id = revision.document_id
			WHERE (document.scope_kind != 'conversation' OR json_extract(document.record, '$.history') = 'latest')
			AND (document.retired_at IS NOT NULL OR revision.seq < (
				SELECT MAX(seq) FROM document_revisions WHERE document_id = revision.document_id AND kind = 'base'
			))`,
	);
}

/** Commits `batches` one call each until one is refused: what one call of all of them must store. */
async function commitEach(storage: Storage, batches: readonly (readonly StorageWrite[])[]): Promise<void> {
	for (const batch of batches) {
		if ((await storage.commit([batch], () => {}, context)).stored === 0) return;
	}
}

/** Commits `batches` and returns what the call reported: stored count, refused or not, and the receipts. */
async function commitOutcome(storage: Storage, batches: readonly (readonly StorageWrite[])[]) {
	const receipts: [number, Seq][] = [];
	const result = await storage.commit(batches, (index, seq) => receipts.push([index, seq]), context);
	return { stored: result.stored, refused: "refused" in result, receipts };
}

describe("SqliteStorage batch commits against the memory reference", () => {
	for (const seed of [1, 2, 3, 4, 5, 6]) {
		it(`agrees with MemoryStorage on random batch calls (seed ${seed})`, async () => {
			const rng = random(seed);
			const reference = new MemoryStorage();
			openStorages.add(reference);
			const groupedDb = await openDatabase();
			const sqlite = await openStorage(groupedDb);
			// The same batches, one call each: a group must leave exactly the rows its batches leave alone.
			const singleDb = await openDatabase();
			const single = await openStorage(singleDb);
			const world: World = {
				nextId: 2,
				conversations: [ROOT_CONVERSATION_ID],
				entries: [],
				tasks: [],
				submissions: [],
				documents: [],
				seqs: [],
				call: new Map(),
				retired: [],
			};
			const root: StorageWrite[][] = [[{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }]];
			expect(await commitOutcome(sqlite, root)).toEqual(await commitOutcome(reference, root));
			await commitEach(single, root);
			let refusals = 0;
			let prefixes = 0;
			let groups = 0;
			for (let round = 0; round < 120; round++) {
				const batches: StorageWrite[][] = [];
				world.call.clear();
				world.retired.length = 0;
				const count = 1 + rng.int(6);
				for (let index = 0; index < count; index++) {
					const writes: StorageWrite[] = [];
					const size = 1 + rng.int(4);
					for (let write = 0; write < size; write++) writes.push(await randomWrite(world, rng, reference));
					if (rng.chance(0.2)) writes.push(...(await replacement(world, rng, reference)));
					batches.push(writes);
				}
				const expected = await commitOutcome(reference, batches);
				const actual = await commitOutcome(sqlite, batches);
				expect(actual, `round ${round}: ${JSON.stringify(batches)}`).toEqual(expected);
				await commitEach(single, batches);
				expect(await dumpTables(groupedDb), `round ${round} tables`).toEqual(await dumpTables(singleDb));
				expect(await staleRevisions(groupedDb), `round ${round} revisions`).toEqual([]);
				if (expected.refused) refusals++;
				if (expected.refused && expected.stored > 0) prefixes++;
				if (!expected.refused && batches.length > 1) groups++;
				world.seqs.push(...expected.receipts.map(([, seq]) => seq));
				const seqs = world.seqs.length > 0 ? [world.seqs[rng.int(world.seqs.length)]!] : [];
				expect(await snapshot(sqlite, world, seqs), `round ${round}`).toEqual(
					await snapshot(reference, world, seqs),
				);
			}
			expect(await snapshot(sqlite, world, world.seqs)).toEqual(await snapshot(reference, world, world.seqs));
			// The generator must exercise every path: refusals, refused prefixes, accepted groups.
			expect(refusals).toBeGreaterThan(10);
			expect(prefixes).toBeGreaterThan(10);
			expect(groups).toBeGreaterThan(10);
		});
	}
});

/** A statement a transaction ran, with its parameters. */
type Ran = { readonly sql: string; readonly params: readonly SqliteValue[] };

/** `db` recording the statements its transactions run. */
function recordStatements(db: SqliteDatabase): { readonly db: SqliteDatabase; readonly ran: Ran[] } {
	const ran: Ran[] = [];
	const recorded = (executor: SqliteExecutor): SqliteExecutor => ({
		exec: (sql) => {
			ran.push({ sql, params: [] });
			return executor.exec(sql);
		},
		run: (sql, ...params) => {
			ran.push({ sql, params });
			return executor.run(sql, ...params);
		},
		runCounted: (sql, ...params) => {
			ran.push({ sql, params });
			return executor.runCounted(sql, ...params);
		},
		get: (sql, ...params) => {
			ran.push({ sql, params });
			return executor.get(sql, ...params);
		},
		all: (sql, ...params) => {
			ran.push({ sql, params });
			return executor.all(sql, ...params);
		},
	});
	return {
		db: {
			...recorded(db),
			transaction: (callback) => db.transaction((tx) => callback(recorded(tx))),
			close: () => db.close(),
		},
		ran,
	};
}

describe("SqliteStorage batch commit statements", () => {
	/**
	 * One call of `count` batches, each a document delta and an entry (as a Session turn writes), after a call that
	 * creates the documents: the statements of the second call, and the database.
	 */
	async function groupOf(count: number, data: JsonValue = 0) {
		const database = await openDatabase();
		const recording = recordStatements(database);
		const storage = await openStorage(recording.db);
		const setup: StorageWrite[] = [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }];
		const documents: DocumentId[] = [];
		for (let index = 0; index < count; index++) {
			const id = await storage.mintId<DocumentId>();
			documents.push(id);
			setup.push({
				type: "document.create",
				record: { id, kind: "counter", scope: { kind: "session" }, key: String(id) },
				content: { kind: "base", version: 1, value: { n: 0 } },
			});
		}
		await storage.commit([setup], () => {}, context);
		const batches: StorageWrite[][] = [];
		for (const id of documents) {
			batches.push([
				{ type: "document.change", id, content: { kind: "delta", version: 1, ops: [["s", ["n"], 1]] } },
				{
					type: "entry",
					value: { id: await storage.mintId<EntryId>(), conversationId: ROOT_CONVERSATION_ID, kind: "note", data },
				},
			]);
		}
		const before = recording.ran.length;
		expect((await storage.commit(batches, () => {}, context)).stored).toBe(count);
		return { statements: recording.ran.slice(before), database };
	}

	it("runs the same eight statements for one batch and for a group of 150", async () => {
		// Metadata read, three check reads (IDs, documents, latest versions), three inserts, metadata write.
		expect((await groupOf(1)).statements).toHaveLength(8);
		const group = await groupOf(150);
		expect(group.statements).toHaveLength(8);
		// One SQL text per table whatever the group's size: prepared statements are reused.
		expect(group.statements.map((statement) => statement.sql)).toEqual(
			(await groupOf(3)).statements.map((statement) => statement.sql),
		);
	});

	it("splits the JSON array of small rows only by size: at most 512 Ki characters each", async () => {
		// 100 entries of 7,000 characters: under the large-row bound each, 700 K characters together.
		const { statements } = await groupOf(100, "x".repeat(7_000));
		const inserts = statements.filter((statement) => statement.sql.startsWith("INSERT INTO entries"));
		expect(inserts.map((statement) => statement.sql.includes("json_each"))).toEqual([true, true]);
		expect(inserts.every((statement) => (statement.params[0] as string).length <= 512 * 1024)).toBe(true);
		expect(statements).toHaveLength(9);
	});

	it("binds rows with much text column by column, 1, 2, 4 ... rows per statement within 100 parameters", async () => {
		// Records full of quotes, which a JSON array would escape a second time: 2 of 400,000 quotes, then 19 of 10,000.
		const quotes = '"'.repeat(400_000);
		const { statements, database } = await groupOf(2, quotes);
		const inserts = statements.filter((statement) => statement.sql.startsWith("INSERT INTO entries"));
		expect(inserts.map((statement) => statement.params.length)).toEqual([10]);
		const rows = await database.all<{ record: string }>("SELECT record FROM entries");
		expect(rows.map((row) => (JSON.parse(row.record) as { data: string }).data === quotes)).toEqual([true, true]);
		// 19 rows of 5 cells: 16 + 2 + 1, the largest power of two within 100 parameters first.
		const many = (await groupOf(19, '"'.repeat(10_000))).statements;
		const bound = many.filter((statement) => statement.sql.startsWith("INSERT INTO entries"));
		expect(bound.map((statement) => statement.params.length)).toEqual([80, 10, 5]);
	});

	it("reads and writes through indexes: no statement of a call scans a stored table", async () => {
		const database = await openDatabase();
		const recording = recordStatements(database);
		const storage = await openStorage(recording.db);
		const conversationId = ROOT_CONVERSATION_ID;
		const record = (id: DocumentId): DocumentCreate => ({
			id,
			kind: "plan",
			scope: { kind: "conversation", conversationId },
			history: "latest",
			fork: "current",
		});
		const first = await storage.mintId<DocumentId>();
		const second = await storage.mintId<DocumentId>();
		await storage.commit(
			[
				[{ type: "conversation", value: { id: conversationId } }],
				[
					{
						type: "document.create",
						record: record(first),
						content: { kind: "base", version: 1, value: { n: 0 } },
					},
				],
			],
			() => {},
			context,
		);
		const before = recording.ran.length;
		// Every read and write the batch path has: IDs, documents, versions, addresses, the upsert, revision drops.
		await storage.commit(
			[
				[{ type: "document.change", id: first, content: { kind: "delta", version: 1, ops: [["s", ["n"], 1]] } }],
				[
					{ type: "document.change", id: first, content: { kind: "base", version: 1, value: { n: 2 } } },
					{ type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId, kind: "note" } },
				],
				[
					{ type: "document.retire", id: first },
					{ type: "document.create", record: record(second), content: { kind: "base", version: 1, value: {} } },
				],
			],
			() => {},
			context,
		);
		const batched = recording.ran.slice(before).filter((statement) => statement.sql.includes("json_each"));
		expect(batched.length).toBeGreaterThan(5);
		for (const { sql, params } of batched) {
			const plan = await database.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params);
			const scans = plan.filter((row) => row.detail.startsWith("SCAN") && !row.detail.includes("VIRTUAL TABLE"));
			expect(scans, sql).toEqual([]);
		}
	});
});

describe("SqliteStorage batch commit regressions", () => {
	for (const order of ["creation first", "retirement first"] as const) {
		it(`refuses a third incarnation after a replacement in an earlier batch of the call (${order})`, async () => {
			// Review finding: retiring A after creating B in one batch must leave B the address's current incarnation.
			const outcomes = [];
			for (const storage of [new MemoryStorage(), await openStorage(await openDatabase())]) {
				openStorages.add(storage);
				const id = (n: number) => idFromNumber<DocumentId>(n);
				const at = (n: number): DocumentCreate => ({ id: id(n), kind: "slot", scope: { kind: "session" } });
				const create = (n: number): StorageWrite => ({
					type: "document.create",
					record: at(n),
					content: { kind: "base", version: 1, value: {} },
				});
				await storage.commit([[create(10)]], () => {}, context);
				const replace: StorageWrite[] = [create(11), { type: "document.retire", id: id(10) }];
				const result = await storage.commit(
					[order === "creation first" ? replace : replace.reverse(), [create(12)]],
					() => {},
					context,
				);
				outcomes.push({ stored: result.stored, refused: String(result.refused) });
			}
			expect(outcomes[1]).toEqual({
				stored: 1,
				refused: "Error: Document address already has a current incarnation",
			});
			expect(outcomes[1]).toEqual(outcomes[0]);
		});
	}
});
