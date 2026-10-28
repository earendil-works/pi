// The store (slice 6a §2, §3, slice 6b §1): opening, the commit step, refusals and unknown outcomes (D4), the id
// allocator (D3), one host per store (rule 7), close.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { isChordError } from "../../../src/next/data/index.ts";
import { Batch } from "../../../src/next/state/internal.ts";
import { sqliteBackend } from "../../../src/next/store/backend.ts";
import { changeDocument, createDocument, retireDocument } from "../../../src/next/store/engine.ts";
import { importStore } from "../../../src/next/store/import.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import { type ChordStore, openStore, type Store } from "../../../src/next/store/store.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import { exported, faultyStore, holdNextCommit, metered, rejection } from "../support.ts";

const ADDRESS = { namespace: "chord", owner: "app.store", kind: "notes", key: "" };
const BASE = { version: 1, fingerprint: "0000000000000000", value: { n: 0 } };

/** A store on a fresh `:memory:` database, as Chord's layers see it. */
async function memoryStore(options?: { readonly outbox?: boolean }): Promise<ChordStore> {
	return (await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context, options)) as ChordStore;
}

/** A fence that admits and records what it adopted. */
function recording(adopted: [number, readonly number[]][] = []) {
	return {
		adopted,
		fence: { admit: () => true, adopt: (seq: number, ids: readonly number[]) => void adopted.push([seq, ids]) },
	};
}

/** Creates the singleton at `ADDRESS` and resolves with its id. */
async function created(store: ChordStore): Promise<number> {
	const { adopted, fence } = recording();
	await store.commit([createDocument(ADDRESS, BASE, JSON.stringify(BASE.value))], fence, context);
	return adopted[0]![1][0]!;
}

/** A staged write whose step fails in the backend: its own code throws, a refusal. */
const BROKEN: StagedWrite = {
	order: "write",
	apply: (step) =>
		step.run("INSERT INTO no_such_table VALUES (1)").then(() => [{ kind: "document.retire", id: 0, revision: 0 }]),
};

let directory: string | undefined;

afterEach(async () => {
	if (directory !== undefined) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

describe("opening", () => {
	it("creates a new store at seq 0 without an outbox, and reopens a file at its last seq and ids", async () => {
		directory = await mkdtemp(join(tmpdir(), "chord-store-"));
		const path = join(directory, "store.sqlite");
		const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context)) as ChordStore;
		expect([store.lastSeq, store.outbox]).toEqual([0, undefined]);
		expect(await created(store)).toBe(2);
		await store.close(context);
		const reopened = (await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context)) as ChordStore;
		expect(reopened.lastSeq).toBe(1);
		const { adopted, fence } = recording();
		await reopened.commit([createDocument({ ...ADDRESS, key: "b" }, BASE, "{}")], fence, context);
		expect(adopted).toEqual([[2, [3]]]);
		await reopened.close(context);
	});

	it("refuses a database that is not UTF-8, closing the backend (rule 12)", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		await db.exec('PRAGMA encoding = "UTF-16le"');
		await expect(openStore(sqliteBackend(db), context)).rejects.toThrow("not UTF-8");
		await expect(db.get("SELECT 1")).rejects.toThrow();
	});
});

describe("the commit step", () => {
	it("assigns one seq per commit, applies retirements before creations, and adopts before the next step", async () => {
		const store = await memoryStore();
		const id = await created(store);
		const events: string[] = [];
		const fence = (name: string) => ({
			admit: () => true,
			adopt: (seq: number, ids: readonly number[]) => void events.push(`${name} ${seq} ${ids}`),
		});
		const first = store.commit(
			[createDocument(ADDRESS, BASE, "{}"), retireDocument(id, 1)],
			fence("recreate"),
			context,
		);
		const second = store.commit(
			[changeDocument(3, 1, { kind: "delta", version: 1, ops: [["s", ["n"], 1]] }, '[["s",["n"],1]]')],
			fence("change"),
			context,
		);
		expect(await Promise.all([first, second])).toEqual([2, 3]);
		expect(events).toEqual(["recreate 2 3", "change 3 "]);
		expect(store.lastSeq).toBe(3);
	});

	it("rejects a commit its fence refuses at the entry released, writing nothing; an empty commit takes no seq", async () => {
		const store = await memoryStore();
		const refused = store.commit(
			[createDocument(ADDRESS, BASE, "{}")],
			{ admit: () => false, adopt: () => {} },
			context,
		);
		expect(await rejection(refused)).toMatchObject({ code: "released" });
		const { adopted, fence } = recording();
		expect(await store.commit([], fence, context)).toBe(0);
		expect(adopted).toEqual([[0, []]]);
		expect(await created(store)).toBe(2);
	});

	it("numbers up to Number.MAX_SAFE_INTEGER after an import near it, then fails storage_failed: no seq repeats", async () => {
		const [manifest, ...rest] = await exported(await memoryStore());
		const parts = [{ ...manifest!, lastSeq: Number.MAX_SAFE_INTEGER - 1 }, ...rest];
		const store = (await importStore(
			sqliteBackend(await openNodeSqliteDatabase(":memory:")),
			parts,
			context,
		)) as ChordStore;
		expect(await created(store)).toBe(2);
		expect(store.lastSeq).toBe(Number.MAX_SAFE_INTEGER);
		const refused = store.commit([createDocument({ ...ADDRESS, key: "b" }, BASE, "{}")], recording().fence, context);
		expect(await rejection(refused)).toMatchObject({ code: "unavailable", reason: "storage_failed" });
		expect(store.lastSeq).toBe(Number.MAX_SAFE_INTEGER);
		expect(await rejection(store.read(async () => null, context))).toMatchObject({ reason: "storage_failed" });
	});

	it("counts one commit and three statements for a delta, four with an outbox (cost guard)", async () => {
		for (const [outbox, statements] of [
			[false, 3],
			[true, 4],
		] as const) {
			const store = await memoryStore({ outbox });
			const id = await created(store);
			const telemetry = await metered();
			const ops = [["s", ["n"], 1]] as const;
			await store.commit(
				[changeDocument(id, 1, { kind: "delta", version: 1, ops }, JSON.stringify(ops))],
				recording().fence,
				telemetry.context,
			);
			expect(telemetry.counts()).toEqual({ "chord.store.commits": 1, "chord.store.statements": statements });
		}
	});
});

describe("refusals and unknown outcomes (D4)", () => {
	it("a step whose own code throws is refused: the commit rejects with that error, nothing is adopted, the store goes on", async () => {
		const store = await memoryStore();
		const told: unknown[] = [];
		store.attach({ failed: (error) => told.push(error), batch: new Batch(() => {}, undefined) });
		const { adopted, fence } = recording();
		const error = await rejection(store.commit([BROKEN], fence, context));
		expect(String(error)).toContain("no such table");
		expect(isChordError(error)).toBe(false);
		expect([adopted, told, store.lastSeq]).toEqual([[], [], 0]);
		expect(await created(store)).toBe(2);
		expect(store.lastSeq).toBe(1);
	});

	it.each([
		["BEGIN IMMEDIATE", undefined],
		["COMMIT", undefined],
		["ROLLBACK", BROKEN],
	] as const)(
		"a failed %s is an unknown outcome: the store stops storage_failed, its host told once",
		async (at, write) => {
			const { store, fail } = await faultyStore();
			const told: unknown[] = [];
			store.attach({ failed: (error) => told.push(error), batch: new Batch(() => {}, undefined) });
			fail(at);
			const writes = write === undefined ? [createDocument(ADDRESS, BASE, "{}")] : [write];
			expect(await rejection(store.commit(writes, recording().fence, context))).toMatchObject({
				code: "unavailable",
				reason: "storage_failed",
			});
			expect(
				await rejection(store.commit([createDocument(ADDRESS, BASE, "{}")], recording().fence, context)),
			).toMatchObject({
				reason: "storage_failed",
			});
			expect(await rejection(store.read(async () => 1, context))).toMatchObject({ reason: "storage_failed" });
			expect(told.length).toBe(1);
			await store.close(context);
			await store.close(context);
		},
	);

	it("an adopt that throws stops the store, an empty commit's too; a conditional update on another revision is refused", async () => {
		const store = await memoryStore();
		const id = await created(store);
		const throwing = {
			admit: () => true,
			adopt: () => {
				throw new Error("adopt threw");
			},
		};
		expect(await rejection(store.commit([retireDocument(id, 1)], throwing, context))).toMatchObject({
			reason: "storage_failed",
		});
		const empty = await memoryStore();
		expect(await rejection(empty.commit([], throwing, context))).toMatchObject({ reason: "storage_failed" });
		expect(await rejection(empty.read(async () => 1, context))).toMatchObject({ reason: "storage_failed" });
		const other = await memoryStore();
		const otherId = await created(other);
		const stale = changeDocument(otherId, 7, { kind: "delta", version: 1, ops: [] }, "[]");
		expect(String(await rejection(other.commit([stale], recording().fence, context)))).toContain(
			"not live at revision 7",
		);
		expect(other.lastSeq).toBe(1);
		expect(await other.read(async () => 1, context)).toBe(1);
	});

	it("spare a read whose context was aborted (aborted), and reject a read that settles after the stop", async () => {
		const { store, fail } = await faultyStore();
		const cancel = withCancel(context);
		cancel.cancel();
		const failing = store.read(() => Promise.reject(new Error("backend")), cancel.context);
		expect(await rejection(failing)).toMatchObject({ code: "aborted" });
		const gate = Promise.withResolvers<number>();
		const late = store.read(() => gate.promise, context);
		fail("COMMIT");
		await rejection(store.commit([createDocument(ADDRESS, BASE, "{}")], recording().fence, context));
		gate.resolve(1);
		expect(await rejection(late)).toMatchObject({ reason: "storage_failed" });
	});

	it("runs a read transaction's queries on one state, guarded as a read", async () => {
		const store = await memoryStore();
		await created(store);
		const counts = await store.readTransaction(
			async (executor) => [
				await executor.get("SELECT count(*) AS n FROM chord_documents"),
				await executor.get("SELECT 1 AS one"),
			],
			context,
		);
		expect(counts).toEqual([{ n: 1 }, { one: 1 }]);
		expect(await rejection(store.readTransaction(() => Promise.reject(new Error("backend")), context))).toMatchObject(
			{
				reason: "storage_failed",
			},
		);
	});
});

describe("the id allocator (D3)", () => {
	/** A staged write raising the allocator above `id`, as an adapter's explicit id does. */
	const raising = (id: number): StagedWrite => ({
		order: "write",
		apply: async (step) => {
			step.ids.raise(id);
			return [];
		},
	});

	it("starts at 2, takes a creation's id as it applies, and gives a mint during a running step the next one", async () => {
		const store = await memoryStore({ outbox: true });
		const held = holdNextCommit(store);
		const commit = store.commit([createDocument(ADDRESS, BASE, "{}")], recording().fence, context);
		await held.entered;
		expect(store.mintId()).toBe(3);
		held.release();
		await commit;
		expect(store.mintId()).toBe(4);
		const [first] = await store.outbox!.read(0, 10, context);
		expect([first!.nextId, (first!.writes[0] as { record: { id: number } }).record.id]).toEqual([4, 2]);
		expect(store.nextId).toBe(4);
	});

	it("leaves a refused step's ids unused and keeps the raised value", async () => {
		const store = await memoryStore();
		await rejection(store.commit([createDocument(ADDRESS, BASE, "{}"), BROKEN], recording().fence, context));
		expect(await created(store)).toBe(3);
	});

	it("saturates at Number.MAX_SAFE_INTEGER across reopen: mints and Chord creations are refused, the store goes on", async () => {
		directory = await mkdtemp(join(tmpdir(), "chord-store-"));
		const path = join(directory, "store.sqlite");
		const store = (await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context)) as ChordStore;
		await store.commit([raising(Number.MAX_SAFE_INTEGER)], recording().fence, context);
		expect(store.nextId).toBe(Number.MAX_SAFE_INTEGER);
		await store.close(context);
		const reopened = (await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context)) as ChordStore;
		expect(reopened.nextId).toBe(Number.MAX_SAFE_INTEGER);
		expect(() => reopened.mintId()).toThrow("ID space is exhausted");
		const refused = reopened.commit([createDocument(ADDRESS, BASE, "{}")], recording().fence, context);
		expect(String(await rejection(refused))).toContain("ID space is exhausted");
		expect(await reopened.read(async () => 1, context)).toBe(1);
		await reopened.close(context);
	});
});

describe("one host per store (rule 7)", () => {
	it("refuses a second attachment until the first detaches", async () => {
		const store = await memoryStore();
		const attachment = { failed: () => {}, batch: new Batch(() => {}, undefined) };
		store.attach(attachment);
		expect(store.batch).toBe(attachment.batch);
		expect(() => store.attach(attachment)).toThrow("already attached");
		store.detach();
		expect(store.batch).toBeUndefined();
		store.attach(attachment);
	});
});

describe("close", () => {
	it("waits for the running step, rejects queued commits and later reads released, and closes the backend", async () => {
		const store = await memoryStore();
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const create = createDocument(ADDRESS, BASE, "{}");
		const held: StagedWrite = {
			order: "create",
			apply: async (step) => {
				entered.resolve();
				await gate.promise;
				return create.apply(step);
			},
		};
		const running = store.commit([held], recording().fence, context);
		await entered.promise;
		const queued = store.commit([createDocument({ ...ADDRESS, key: "q" }, BASE, "{}")], recording().fence, context);
		const closed = (store as Store).close(context);
		gate.resolve();
		expect(await running).toBe(1);
		expect(await rejection(queued)).toMatchObject({ code: "released" });
		await closed;
		expect(await rejection(store.read(async () => 1, context))).toMatchObject({ code: "released" });
	});
});
