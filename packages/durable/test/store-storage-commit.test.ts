// StoreStorage's commit path (`Storage.commit` over `ChordStore.commitSeries`), p3's primary storage: per call one
// backend transaction with one seq per batch; Durable's checks of a batch refuse it in its turn, the batches before it
// stored; a failed statement rolls the call back and rejects, the store going on; a failed `COMMIT` stops the store;
// receipts after `COMMIT`; each commit published in a host batch of its own; other users of the store wait their turn.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { BACKGROUND_CONTEXT, withTelemetry } from "@earendil-works/chord/context";
import { type ChordStore, createHost, openStore, sqliteBackend } from "@earendil-works/chord/next";
import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/chord/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { afterEach, describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { MemoryStorage } from "../src/index.ts";
import { SessionImpl } from "../src/session/session.ts";
import { StoreStorage } from "../src/storage/store/index.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";
import type {
	CommitResult,
	ConversationId,
	DocumentCreate,
	DocumentId,
	EntryId,
	Seq,
	Storage,
	StorageWrite,
} from "../src/types.ts";
import { ROOT_CONVERSATION_ID } from "../src/types.ts";
import { openStoreStorage } from "./store-storage-support.ts";

const context = BACKGROUND_CONTEXT;

let directory: string | undefined;

afterEach(async () => {
	if (directory !== undefined) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

/** A fresh SQLite file in this test's directory. */
async function storePath(): Promise<string> {
	directory ??= await mkdtemp(join(tmpdir(), "pi-durable-store-commit-"));
	return join(directory, `store-${Math.random().toString(36).slice(2)}.sqlite`);
}

/**
 * What the next backend transaction does besides its work: `commit` fails it after its work (a failed `COMMIT`, an
 * unknown outcome); `fail` fails a statement it matches (by its SQL and its index, from 1), as a backend error; `hold`
 * holds a statement until the promise it returns settles.
 */
type Faults = {
	commit: boolean;
	fail: ((sql: string, index: number) => boolean) | undefined;
	hold: ((sql: string, index: number) => Promise<void> | undefined) | undefined;
};

/**
 * A storage with its root conversation, over a store with an outbox on the SQLite file at `path`, whose backend counts
 * its transactions and the statements of the last one, and takes `faults` for its next transaction.
 */
async function counted(path = ":memory:") {
	const db = await openNodeSqliteDatabase(path);
	const counts = { transactions: 0, statements: 0 };
	const faults: Faults = { commit: false, fail: undefined, hold: undefined };
	const backend: SqliteDatabase = {
		exec: (sql) => db.exec(sql),
		run: (sql, ...params) => db.run(sql, ...params),
		runCounted: (sql, ...params) => db.runCounted(sql, ...params),
		get: (sql, ...params) => db.get(sql, ...params),
		all: (sql, ...params) => db.all(sql, ...params),
		close: () => db.close(),
		transaction: (work) => {
			counts.transactions++;
			counts.statements = 0;
			const { commit, fail, hold } = faults;
			faults.commit = false;
			faults.fail = undefined;
			faults.hold = undefined;
			return db.transaction(async (executor) => {
				const call = async <T>(sql: string, run: () => Promise<T>): Promise<T> => {
					const index = ++counts.statements;
					await hold?.(sql, index);
					if (fail?.(sql, index) === true) throw new Error(`injected: statement ${index} failed`);
					return run();
				};
				const result = await work({
					exec: (sql) => call(sql, () => executor.exec(sql)),
					run: (sql, ...params) => call(sql, () => executor.run(sql, ...params)),
					runCounted: (sql, ...params) => call(sql, () => executor.runCounted(sql, ...params)),
					get: (sql, ...params) => call(sql, () => executor.get(sql, ...params)),
					all: (sql, ...params) => call(sql, () => executor.all(sql, ...params)),
				} satisfies SqliteExecutor);
				if (commit) throw new Error("COMMIT failed");
				return result;
			});
		},
	};
	const store = (await openStore(sqliteBackend(backend), context, { outbox: true })) as ChordStore;
	const storage = await StoreStorage.open(store, "harness", context);
	await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
	return { store, storage, counts, faults };
}

/** The same storage opened again on the file at `path`, as another process would. */
async function reopen(path: string) {
	const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context)) as ChordStore;
	return { store, storage: await StoreStorage.open(store, "harness", context) };
}

const entryWrite = (id: EntryId, kind = "m"): StorageWrite => ({
	type: "entry",
	value: { id, conversationId: ROOT_CONVERSATION_ID, kind },
});

/** One macrotask: what can run before it has run. */
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The store's outbox commits, by seq. */
async function outboxSeqs(store: ChordStore): Promise<number[]> {
	const rows = await store.read((executor) => executor.all<{ seq: number }>("SELECT seq FROM chord_outbox"), context);
	return rows.map((row) => row.seq);
}

describe("one transaction per call", () => {
	it("stores the batches in one backend transaction, one seq and one outbox commit each, receipts in order", async () => {
		const { store, storage, counts } = await counted();
		const ids = [await storage.mintId<EntryId>(), await storage.mintId<EntryId>(), await storage.mintId<EntryId>()];
		const before = counts.transactions;
		const last = store.lastSeq;
		const receipts: [number, Seq][] = [];
		const result = await storage.commit(
			ids.map((id) => [entryWrite(id)]),
			(index, seq) => receipts.push([index, seq]),
			context,
		);
		expect(result).toEqual({ stored: 3 });
		expect(counts.transactions - before).toBe(1);
		expect(receipts).toEqual([
			[0, last + 1],
			[1, last + 2],
			[2, last + 3],
		]);
		for (const [index, id] of ids.entries()) {
			expect((await storage.entry(id, context))?.commitSeq).toBe(last + 1 + index);
		}
		const outbox = await store.read(
			(executor) => executor.all<{ seq: number }>("SELECT seq FROM chord_outbox WHERE seq > ?", last),
			context,
		);
		expect(outbox.map((row) => row.seq)).toEqual([last + 1, last + 2, last + 3]);
		await store.close(context);
	});

	it("writes the metadata once per call: three statements per entry append, plus one (cost guard)", async () => {
		const { store, storage, counts } = await counted();
		const telemetry = new InMemoryTelemetryContext();
		const span = await telemetry.startSpan({ name: "test" }, (each) => each);
		const metered = withTelemetry(span, context);
		const statements = (): number =>
			telemetry
				.getMetrics()
				.filter(({ name }) => name === "chord.store.statements")
				.reduce((total, { value }) => total + value, 0);
		// Alone, an append is its id check, its row and claim, its outbox commit, and the metadata.
		await commitWrites(storage, [entryWrite(await storage.mintId<EntryId>())], metered);
		expect(statements()).toBe(5);
		const ids = [await storage.mintId<EntryId>(), await storage.mintId<EntryId>(), await storage.mintId<EntryId>()];
		const before = counts.transactions;
		await storage.commit(
			ids.map((id) => [entryWrite(id)]),
			() => {},
			metered,
		);
		expect([counts.transactions - before, statements() - 5]).toEqual([1, 3 * 4 + 1]);
		await store.close(context);
	});
});

describe("refusals: the batches before the refused one stand", () => {
	it("stores the batches before a refused one with Durable's message, none after it, and goes on", async () => {
		const { store, storage } = await counted();
		const first = await storage.mintId<EntryId>();
		const after = await storage.mintId<EntryId>();
		const last = store.lastSeq;
		const receipts: number[] = [];
		const result = await storage.commit(
			[[entryWrite(first)], [entryWrite(first, "again")], [entryWrite(after)]],
			(index) => receipts.push(index),
			context,
		);
		expect(result.stored).toBe(1);
		expect(String(result.refused)).toBe(`Error: ID ${first} already belongs to entry`);
		expect(receipts).toEqual([0]);
		expect((await storage.entry(first, context))?.entry.kind).toBe("m");
		expect(await storage.entry(after, context)).toBeUndefined();
		expect(store.lastSeq).toBe(last + 1);
		expect(await commitWrites(storage, [entryWrite(after)], context)).toBe(last + 2);
		await store.close(context);
	});

	it("refuses a batch its staging fails in that batch's turn, keeping the batches before it (review)", async () => {
		const { store, storage } = await counted();
		const entry = await storage.mintId<EntryId>();
		const document = await storage.mintId<DocumentId>();
		const receipts: number[] = [];
		const result = await storage.commit(
			[
				[entryWrite(entry)],
				// Staging refuses it: one document retired twice.
				[
					{ type: "document.retire", id: document },
					{ type: "document.retire", id: document },
				],
			],
			(index) => receipts.push(index),
			context,
		);
		expect(result.stored).toBe(1);
		expect(String(result.refused)).toBe(`Error: Document ${document} is retired more than once`);
		expect(receipts).toEqual([0]);
		expect(await storage.entry(entry, context)).toBeDefined();
		await store.close(context);
	});

	it.each([
		[
			"a duplicate retirement",
			[
				{ type: "document.retire", id: 101 },
				{ type: "document.retire", id: 101 },
			],
		],
		[
			"a duplicate content command",
			[
				{ type: "document.change", id: 101, content: { kind: "base", version: 1, value: {} } },
				{ type: "document.change", id: 101, content: { kind: "base", version: 1, value: {} } },
			],
		],
	] as const)(
		"refuses a later batch with %s as Memory does, keeping the prefix (review)",
		async (_name, malformed) => {
			const batches: StorageWrite[][] = [
				[{ type: "conversation", value: { id: idFromNumber<ConversationId>(100) } }],
				malformed.map((write) => ({ ...write, id: idFromNumber<DocumentId>(write.id) })) as StorageWrite[],
			];
			const outcomes = [];
			for (const storage of [new MemoryStorage(), await openStoreStorage(":memory:")]) {
				const receipts: number[] = [];
				const result = await storage.commit(batches, (index) => receipts.push(index), context);
				const conversation = await storage.conversation(idFromNumber<ConversationId>(100), context);
				outcomes.push({ stored: result.stored, refused: String(result.refused), receipts, conversation });
				await storage.close(context);
			}
			expect(outcomes[0]).toMatchObject({ stored: 1, receipts: [0], conversation: { id: 100 } });
			expect(outcomes[1]).toEqual(outcomes[0]);
		},
	);

	it.each([
		[
			"a change of a document an earlier batch retired",
			(id: DocumentId): StorageWrite[][] => [
				[{ type: "document.retire", id }],
				[{ type: "document.change", id, content: { kind: "base", version: 1, value: { n: 2 } } }],
			],
			"is retired",
		],
		[
			"a creation at the address an earlier batch took",
			(id: DocumentId): StorageWrite[][] => [
				[
					{
						type: "document.create",
						record: { id: idFromNumber<DocumentId>(id + 1), kind: "n", key: "taken", scope: { kind: "session" } },
						content: { kind: "base", version: 1, value: { n: 2 } },
					},
				],
				[
					{
						type: "document.create",
						record: { id: idFromNumber<DocumentId>(id + 2), kind: "n", key: "taken", scope: { kind: "session" } },
						content: { kind: "base", version: 1, value: { n: 3 } },
					},
				],
			],
			"already has a current incarnation",
		],
	] as const)("refuses %s against the state the batches before it left", async (_name, calls, message) => {
		const { store, storage } = await counted();
		const document = idFromNumber<DocumentId>(200);
		await commitWrites(
			storage,
			[
				{
					type: "document.create",
					record: { id: document, kind: "n", scope: { kind: "session" } },
					content: { kind: "base", version: 1, value: { n: 1 } },
				},
			],
			context,
		);
		const last = store.lastSeq;
		const receipts: number[] = [];
		const result = await storage.commit(calls(document), (index) => receipts.push(index), context);
		expect(result.stored).toBe(1);
		expect(String(result.refused)).toContain(message);
		expect([receipts, store.lastSeq]).toEqual([[0], last + 1]);
		expect((await outboxSeqs(store)).at(-1)).toBe(last + 1);
		await store.close(context);
	});

	it("refuses a batch whose rows staging cannot encode, keeping the batches before it", async () => {
		const { store, storage } = await counted();
		const entry = await storage.mintId<EntryId>();
		const receipts: number[] = [];
		// No integer: the Session never sends one (Storage trusts it); the store's columns refuse it at staging.
		const result = await storage.commit(
			[[entryWrite(entry)], [entryWrite(idFromNumber<EntryId>(1.5))]],
			(index) => receipts.push(index),
			context,
		);
		expect(result.stored).toBe(1);
		expect(String(result.refused)).toContain('column "id": 1.5 is not a int value');
		expect(receipts).toEqual([0]);
		expect(await storage.entry(entry, context)).toBeDefined();
		await store.close(context);
	});

	it("checks a batch against the batches before it in the call: a copy reads their state", async () => {
		const { store, storage } = await counted();
		const source = await storage.mintId<DocumentId>();
		const child = await storage.mintId<ConversationId>();
		const copy = await storage.mintId<DocumentId>();
		const record = (id: DocumentId, conversationId: ConversationId) =>
			({
				id,
				kind: "c",
				scope: { kind: "conversation", conversationId },
				history: "rewindable",
				fork: "asOf",
			}) as const;
		const result = await storage.commit(
			[
				[
					{
						type: "document.create",
						record: record(source, ROOT_CONVERSATION_ID),
						content: { kind: "base", version: 1, value: { n: 1 } },
					},
				],
				[{ type: "document.change", id: source, content: { kind: "delta", version: 1, ops: [["s", ["n"], 2]] } }],
				[
					{ type: "conversation", value: { id: child } },
					{ type: "document.copy", record: record(copy, child), source: { id: source, at: "current" } },
				],
			],
			() => {},
			context,
		);
		expect(result).toEqual({ stored: 3 });
		expect((await storage.document(copy, "current", context))?.value).toEqual({ n: 2 });
		await store.close(context);
	});
});

describe("failures: a rollback rejects, an unknown outcome stops the store", () => {
	it("rejects with nothing stored when a batch's check fails in the backend, and the store goes on", async () => {
		const { store, storage, faults } = await counted();
		const [first, second] = [await storage.mintId<EntryId>(), await storage.mintId<EntryId>()];
		const last = store.lastSeq;
		// The second batch's id check: its first read of the record ids.
		let claimReads = 0;
		faults.fail = (sql) => sql.includes("record_ids") && ++claimReads === 2;
		const receipts: number[] = [];
		await expect(
			storage.commit([[entryWrite(first)], [entryWrite(second)]], (index) => receipts.push(index), context),
		).rejects.toThrow("injected");
		expect([receipts, store.lastSeq]).toEqual([[], last]);
		expect(await storage.entry(first, context)).toBeUndefined();
		expect(await commitWrites(storage, [entryWrite(first)], context)).toBe(last + 1);
		await store.close(context);
	});

	it("a failed COMMIT is an unknown outcome: the call rejects storage_failed, nothing is received or stored", async () => {
		const path = await storePath();
		const { store, storage, faults } = await counted(path);
		const ids = [await storage.mintId<EntryId>(), await storage.mintId<EntryId>()];
		const last = store.lastSeq;
		faults.commit = true;
		const receipts: number[] = [];
		await expect(
			storage.commit(
				ids.map((id) => [entryWrite(id)]),
				(index) => receipts.push(index),
				context,
			),
		).rejects.toMatchObject({ code: "unavailable", reason: "storage_failed" });
		expect(receipts).toEqual([]);
		await expect(storage.entry(ids[0]!, context)).rejects.toMatchObject({ reason: "storage_failed" });
		await store.close(context);
		const reopened = await reopen(path);
		expect(await reopened.storage.entry(ids[0]!, context)).toBeUndefined();
		expect(await commitWrites(reopened.storage, [entryWrite(ids[1]!)], context)).toBe(last + 1);
		await reopened.store.close(context);
	});

	/** The record the audit's source document and its copy share. */
	const record = (id: number, conversationId: number): DocumentCreate => ({
		id: idFromNumber<DocumentId>(id),
		kind: "audit",
		scope: { kind: "conversation", conversationId: idFromNumber<ConversationId>(conversationId) },
		history: "rewindable",
		fork: "asOf",
	});

	/** The source document, stored before the call. */
	const SEED: StorageWrite[] = [
		{
			type: "document.create",
			record: record(100, ROOT_CONVERSATION_ID),
			content: { kind: "base", version: 1, value: { n: 0 } },
		},
	];

	/** A delta of the source document setting `n`. */
	const delta = (n: number): StorageWrite => ({
		type: "document.change",
		id: idFromNumber<DocumentId>(100),
		content: { kind: "delta", version: 1, ops: [["s", ["n"], n]] },
	});

	/**
	 * Three batches: an entry and a delta; a conversation, a copy of the source as the first batch left it and an
	 * entry; then an entry and a delta, or, `refused`, an entry whose id the first batch took.
	 */
	const batches = (third: "valid" | "refused"): StorageWrite[][] => [
		[entryWrite(idFromNumber<EntryId>(101), "b1"), delta(1)],
		[
			{ type: "conversation", value: { id: idFromNumber<ConversationId>(105) } },
			{
				type: "document.copy",
				record: record(102, 105),
				source: { id: idFromNumber<DocumentId>(100), at: "current" },
			},
			entryWrite(idFromNumber<EntryId>(103), "b2"),
		],
		third === "valid"
			? [entryWrite(idFromNumber<EntryId>(104), "b3"), delta(2)]
			: [entryWrite(idFromNumber<EntryId>(101), "again")],
	];

	/** What a storage holds of the audit's records. */
	async function stateOf(storage: Storage) {
		const entries: (string | null)[] = [];
		for (const id of [101, 103, 104])
			entries.push((await storage.entry(idFromNumber<EntryId>(id), context))?.entry.kind ?? null);
		return {
			entries,
			source: (await storage.document(idFromNumber<DocumentId>(100), "current", context))?.value ?? null,
			copy: (await storage.document(idFromNumber<DocumentId>(102), "current", context))?.value ?? null,
			child: (await storage.conversation(idFromNumber<ConversationId>(105), context)) ?? null,
		};
	}

	/** What a call returned and what it left: its result, its receipts' seqs after the store's last one, the state. */
	async function outcomeOf(storage: Storage, third: "valid" | "refused", last: number) {
		const seqs: number[] = [];
		const result: CommitResult = await storage.commit(
			batches(third),
			(_index, seq) => seqs.push(seq - last),
			context,
		);
		return { stored: result.stored, refused: String(result.refused), seqs, state: await stateOf(storage) };
	}

	/** Every error in `error`'s cause chain, as text. */
	function chain(error: unknown): string[] {
		const messages: string[] = [];
		for (let at = error; at instanceof Error; at = at.cause) messages.push(at.message);
		return messages;
	}

	it.each(["valid", "refused"] as const)(
		"rolls a 3-batch call back at a failure of any of its statements, as at a failed COMMIT, and reopens before it (third %s)",
		async (third) => {
			// What MemoryStorage makes of the call: the outcome every retry must reach.
			const memory = new MemoryStorage();
			await commitWrites(memory, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
			await commitWrites(memory, SEED, context);
			const expected = await outcomeOf(memory, third, 2);
			expect(expected).toMatchObject(
				third === "valid" ? { stored: 3, seqs: [1, 2, 3] } : { stored: 2, seqs: [1, 2] },
			);
			// The statements of the call's transaction (a read transaction after it would count its own).
			const probe = await counted();
			await commitWrites(probe.storage, SEED, context);
			const result = await probe.storage.commit(batches(third), () => {}, context);
			const total = probe.counts.statements;
			// Its cost: no read beyond a batch's checks, the metadata once (statement counts per batch in the cost guard).
			expect(total).toBe(third === "valid" ? 29 : 23);
			expect(result.stored).toBe(expected.stored);
			expect(await stateOf(probe.storage)).toEqual(expected.state);
			await probe.store.close(context);
			// Each statement in turn, then the COMMIT.
			for (let at = 1; at <= total + 1; at++) {
				const path = await storePath();
				const opened = await counted(path);
				await commitWrites(opened.storage, SEED, context);
				const last = opened.store.lastSeq;
				const outbox = await outboxSeqs(opened.store);
				const before = await stateOf(opened.storage);
				if (at <= total) opened.faults.fail = (_sql, index) => index === at;
				else opened.faults.commit = true;
				const receipts: number[] = [];
				const error = await opened.storage
					.commit(batches(third), (each) => receipts.push(each), context)
					.then(
						() => undefined,
						(rejection: unknown) => rejection,
					);
				expect(receipts).toEqual([]);
				expect(opened.store.lastSeq).toBe(last);
				if (at <= total) {
					// A rollback: the call rejects with its failure, the store goes on.
					expect(chain(error)).toContain(`injected: statement ${at} failed`);
					expect(await stateOf(opened.storage)).toEqual(before);
				} else {
					expect(error).toMatchObject({ code: "unavailable", reason: "storage_failed" });
				}
				await opened.store.close(context);
				// On disk: as before the call, the seq, the outbox, the records and the allocator.
				const again = await reopen(path);
				expect(again.store.lastSeq).toBe(last);
				expect(await outboxSeqs(again.store)).toEqual(outbox);
				expect(await stateOf(again.storage)).toEqual(before);
				expect(await again.storage.mintId<EntryId>()).toBeGreaterThan(100);
				// A retry reaches MemoryStorage's outcome.
				expect(await outcomeOf(again.storage, third, last)).toEqual(expected);
				expect(await outboxSeqs(again.store)).toEqual([...outbox, ...expected.seqs.map((seq) => last + seq)]);
				await again.store.close(context);
			}
		},
	);

	it("a call on a closed storage, or on a stopped store, rejects and stores nothing", async () => {
		const { store, storage, faults } = await counted();
		const entry = await storage.mintId<EntryId>();
		faults.commit = true;
		await expect(commitWrites(storage, [entryWrite(entry)], context)).rejects.toMatchObject({
			reason: "storage_failed",
		});
		await expect(storage.commit([[entryWrite(entry)]], () => {}, context)).rejects.toMatchObject({
			reason: "storage_failed",
		});
		await store.close(context);
		const other = await counted();
		await other.storage.close(context);
		await expect(other.storage.commit([[entryWrite(entry)]], () => {}, context)).rejects.toThrow("closed");
		await other.store.close(context);
	});

	it("a call queued when the store closes rejects released, and stores nothing; the running one is stored", async () => {
		const path = await storePath();
		const { store, storage, faults } = await counted(path);
		const [first, second] = [await storage.mintId<EntryId>(), await storage.mintId<EntryId>()];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		faults.hold = (_sql, index) => {
			if (index !== 1) return undefined;
			entered.resolve();
			return release.promise;
		};
		const running = storage.commit([[entryWrite(first)]], () => {}, context);
		await entered.promise;
		const queued = storage.commit([[entryWrite(second)]], () => {}, context);
		const closing = store.close(context);
		release.resolve();
		expect(await running).toEqual({ stored: 1 });
		await expect(queued).rejects.toMatchObject({ code: "released" });
		await closing;
		const again = await reopen(path);
		expect(await again.storage.entry(first, context)).toBeDefined();
		expect(await again.storage.entry(second, context)).toBeUndefined();
		await again.store.close(context);
	});
});

describe("durability", () => {
	it("keeps every batch of a stored call across a crash: reopened, the seqs, rows, documents and ids are there", async () => {
		const path = await storePath();
		const { store, storage } = await counted(path);
		const entry = await storage.mintId<EntryId>();
		const document = await storage.mintId<DocumentId>();
		const record = {
			id: document,
			kind: "n",
			scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
			history: "rewindable",
			fork: "asOf",
		} as const;
		const seqs: Seq[] = [];
		await storage.commit(
			[
				[entryWrite(entry)],
				[{ type: "document.create", record, content: { kind: "base", version: 1, value: { n: 1 } } }],
				[{ type: "document.change", id: document, content: { kind: "delta", version: 1, ops: [["s", ["n"], 2]] } }],
			],
			(_index, seq) => seqs.push(seq),
			context,
		);
		const minted = await storage.mintId<EntryId>();
		// A crash: the store is never closed; another process opens the file.
		const { store: other, storage: reopened } = await reopen(path);
		expect((await reopened.entry(entry, context))?.commitSeq).toBe(seqs[0]);
		expect((await reopened.document(document, seqs[1]!, context))?.value).toEqual({ n: 1 });
		expect((await reopened.document(document, "current", context))?.value).toEqual({ n: 2 });
		expect(await reopened.mintId<EntryId>()).toBeGreaterThan(document);
		expect(await commitWrites(reopened, [entryWrite(minted)], context)).toBe(seqs[2]! + 1);
		await other.close(context);
		await store.close(context);
	});
});

describe("publication", () => {
	it("publishes each commit of a call in a host batch of its own, after the call's one transaction", async () => {
		const { store, storage, counts } = await counted();
		const host = createHost({ store, onError: () => {} });
		const session = new SessionImpl(storage);
		const events: string[] = [];
		session.followCommits((commit) => {
			if (commit.kind !== "stored") return;
			const batch = store.batch!;
			events.push(`publish ${commit.seq} running=${batch.running}`);
			batch.flushing(() => events.push(`flush ${commit.seq}`));
		});
		// Hold the first call, so the commits after it are sent together in the next one.
		const calls: number[] = [];
		const gate = Promise.withResolvers<void>();
		const commit = storage.commit.bind(storage);
		storage.commit = async (batches, receive, ctx) => {
			calls.push(batches.length);
			if (calls.length === 1) await gate.promise;
			return commit(batches, receive, ctx);
		};
		const first = session.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "a" }), context);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rest = [1, 2, 3].map((n) =>
			session.commit((tx) => tx.appendEntry(ROOT_CONVERSATION_ID, { kind: `b${n}` }), context),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const before = counts.transactions;
		gate.resolve();
		await Promise.all([first, ...rest]);
		expect(calls).toEqual([1, 3]);
		expect(counts.transactions - before).toBe(2);
		const seq = store.lastSeq;
		expect(events).toEqual(
			[seq - 3, seq - 2, seq - 1, seq].flatMap((each) => [`publish ${each} running=true`, `flush ${each}`]),
		);
		await session.close(context);
		await host.close(context);
		await store.close(context);
	});
});

describe("other users of the store", () => {
	it("another owner's call waits for a series in its transaction; the series' receipts come first", async () => {
		const { store, storage, faults } = await counted();
		const other = await StoreStorage.open(store, "other", context);
		const [first, second] = [await storage.mintId<EntryId>(), await storage.mintId<EntryId>()];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		faults.hold = (_sql, index) => {
			if (index !== 2) return undefined;
			entered.resolve();
			return release.promise;
		};
		const events: string[] = [];
		const series = storage.commit(
			[[entryWrite(first)], [entryWrite(second)]],
			(index, seq) => events.push(`harness ${index} ${seq}`),
			context,
		);
		await entered.promise;
		const waiting = other.commit(
			[[{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }]],
			(index, seq) => events.push(`other ${index} ${seq}`),
			context,
		);
		await macrotask();
		expect(events).toEqual([]);
		const last = store.lastSeq;
		release.resolve();
		await Promise.all([series, waiting]);
		expect(events).toEqual([`harness 0 ${last + 1}`, `harness 1 ${last + 2}`, `other 0 ${last + 3}`]);
		expect((await outboxSeqs(store)).slice(-3)).toEqual([last + 1, last + 2, last + 3]);
		await other.close(context);
		await store.close(context);
	});

	it("a read during a series sees all of it or none of it", async () => {
		const { store, storage, faults } = await counted();
		const [first, second] = [await storage.mintId<EntryId>(), await storage.mintId<EntryId>()];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		// Held after the first batch's writes, in the second batch's check.
		let claimReads = 0;
		faults.hold = (sql) => {
			if (!sql.includes("record_ids") || ++claimReads !== 2) return undefined;
			entered.resolve();
			return release.promise;
		};
		const series = storage.commit([[entryWrite(first)], [entryWrite(second)]], () => {}, context);
		await entered.promise;
		const read = Promise.all([storage.entry(first, context), storage.entry(second, context)]);
		await macrotask();
		release.resolve();
		await series;
		const [one, two] = await read;
		expect([one === undefined, two === undefined]).toEqual([false, false]);
		await store.close(context);
	});

	it("an export holds the queue: a series waits for it and is not in its archive", async () => {
		const { store, storage } = await counted();
		const entry = await storage.mintId<EntryId>();
		const last = store.lastSeq;
		const parts = store.export(context);
		const manifest = await parts.next();
		expect(manifest.value).toMatchObject({ kind: "manifest", lastSeq: last });
		let settled = false;
		const series = storage
			.commit([[entryWrite(entry)]], () => {}, context)
			.finally(() => {
				settled = true;
			});
		await macrotask();
		expect(settled).toBe(false);
		await parts.return?.();
		expect(await series).toEqual({ stored: 1 });
		expect(store.lastSeq).toBe(last + 1);
		await store.close(context);
	});
});

describe("GC", () => {
	it("keeps nothing of a settled call: its batches are collected", async () => {
		setFlagsFromString("--expose-gc");
		const gc = runInNewContext("gc") as () => void;
		const { store, storage } = await counted();
		const sent = async (): Promise<WeakRef<object>> => {
			const batches = [[entryWrite(await storage.mintId<EntryId>())]];
			await storage.commit(batches, () => {}, context);
			return new WeakRef(batches);
		};
		const ref = await sent();
		for (let round = 0; round < 10 && ref.deref() !== undefined; round++) {
			await new Promise((resolve) => setImmediate(resolve));
			gc();
		}
		expect(ref.deref()).toBeUndefined();
		await store.close(context);
	});
});
