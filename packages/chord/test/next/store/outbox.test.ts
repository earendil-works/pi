// Tests of the outbox (slice 6a §2; decisions "The outbox is optional, internal and versioned", small items 3-4): on,
// off and kept across opens, its commits in their recorded form, `trim` and its floor, and the format check.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { sqliteBackend } from "../../../src/next/store/backend.ts";
import { changeDocument, createDocument } from "../../../src/next/store/engine.ts";
import { OUTBOX_FORMAT } from "../../../src/next/store/outbox.ts";
import { TABLES } from "../../../src/next/store/schema.ts";
import { type ChordStore, openStore } from "../../../src/next/store/store.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";
import { memoryStore, rejection } from "../support.ts";

const ADDRESS = { namespace: "chord", owner: "app.store", kind: "notes", key: "" };
const BASE = { version: 1, fingerprint: "0000000000000000", value: { n: 0 } };
const OPEN = { admit: () => true, adopt: () => {} };

/** Creates the singleton at `ADDRESS` (with `key`) in one commit. */
async function created(store: ChordStore, key = ""): Promise<void> {
	await store.commit([createDocument({ ...ADDRESS, key }, BASE, JSON.stringify(BASE.value))], OPEN, context);
}

let directory: string | undefined;

afterEach(async () => {
	if (directory !== undefined) await rm(directory, { recursive: true, force: true });
	directory = undefined;
});

/** A store on a fresh file, reopened by `open`. */
async function onFile() {
	directory = await mkdtemp(join(tmpdir(), "chord-outbox-"));
	const path = join(directory, "store.sqlite");
	return async (outbox?: boolean) =>
		(await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context, { outbox })) as ChordStore;
}

describe("the outbox", () => {
	it("is off for a new store, on from the seq it is turned on at, kept when omitted, dropped when turned off", async () => {
		const open = await onFile();
		let store = await open();
		await created(store);
		await store.close(context);
		store = await open(true);
		expect(store.outbox?.floor).toBe(1);
		const id = 2;
		const ops = [["s", ["n"], 2]] as const;
		await store.commit(
			[changeDocument(id, 1, { kind: "delta", version: 1, ops }, JSON.stringify(ops))],
			OPEN,
			context,
		);
		await store.close(context);
		store = await open();
		expect(await store.outbox!.read(1, 10, context)).toEqual([
			{
				seq: 2,
				nextId: 3,
				writes: [{ kind: "document.change", id, revision: 1, content: { kind: "delta", version: 1, ops } }],
			},
		]);
		expect(await rejection(store.outbox!.read(0, 10, context))).toMatchObject({ code: "invalid", reason: "args" });
		expect(await rejection(store.outbox!.read(3, 10, context))).toMatchObject({ code: "invalid", reason: "args" });
		await store.close(context);
		store = await open(false);
		expect(store.outbox).toBeUndefined();
		await store.close(context);
	});

	it("records creations with their ids and seqs; trim is idempotent and refuses beyond lastSeq", async () => {
		const store = await memoryStore({ outbox: true });
		await created(store);
		const [commit] = await store.outbox!.read(0, 10, context);
		expect(commit!.writes[0]).toMatchObject({
			kind: "document.create",
			record: { id: 2, createdAt: 1, ...ADDRESS },
			base: BASE,
		});
		await store.outbox!.trim(1, context);
		await store.outbox!.trim(1, context);
		expect(store.outbox!.floor).toBe(1);
		expect(await store.outbox!.read(1, 10, context)).toEqual([]);
		expect(await rejection(store.outbox!.trim(2, context))).toMatchObject({ code: "invalid", reason: "args" });
	});

	it("overlapping trims run one at a time: the stored floor never moves back and equals the one in memory", async () => {
		const open = await onFile();
		let store = await open(true);
		for (let i = 0; i < 11; i++) await created(store, `k${i}`);
		await Promise.all([store.outbox!.trim(9, context), store.outbox!.trim(3, context)]);
		expect(store.outbox!.floor).toBe(9);
		await store.close(context);
		store = await open();
		expect(store.outbox!.floor).toBe(9);
		expect(await rejection(store.outbox!.read(3, 10, context))).toMatchObject({ code: "invalid", reason: "args" });
		expect((await store.outbox!.read(9, 10, context)).map(({ seq }) => seq)).toEqual([10, 11]);
		await store.close(context);
	});

	it("a read waits for a trim whose commit has not returned: the trimmed floor refuses it, never an empty page", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		const transaction = db.transaction.bind(db);
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const store = (await openStore(sqliteBackend(db), context, { outbox: true })) as ChordStore;
		await created(store);
		// The trim's DELETE committed; its transaction has not returned (the floor in memory is still 0).
		db.transaction = async (fn) => {
			const result = await transaction(fn);
			entered.resolve();
			await gate.promise;
			return result;
		};
		const trim = store.outbox!.trim(1, context);
		await entered.promise;
		db.transaction = transaction;
		const read = rejection(store.outbox!.read(0, 100, context));
		gate.resolve();
		await trim;
		expect(await read).toMatchObject({ code: "invalid", reason: "args" });
		await store.close(context);
	});

	it("a trim waits for a read in flight: the read gets the commits it was admitted for", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		const store = (await openStore(sqliteBackend(db), context, { outbox: true })) as ChordStore;
		await created(store);
		const all = db.all.bind(db);
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		db.all = (async (sql: string, ...params: never[]) => {
			entered.resolve();
			await gate.promise;
			return all(sql, ...params);
		}) as typeof db.all;
		const read = store.outbox!.read(0, 100, context);
		await entered.promise;
		db.all = all;
		const trim = store.outbox!.trim(1, context);
		gate.resolve();
		expect((await read).map(({ seq }) => seq)).toEqual([1]);
		await trim;
		expect(store.outbox!.floor).toBe(1);
		await store.close(context);
	});

	it("a commit stored in a newer format is refused unavailable; the data stays", async () => {
		const open = await onFile();
		let store = await open(true);
		await created(store);
		await store.close(context);
		const db = await openNodeSqliteDatabase(join(directory!, "store.sqlite"));
		await db.run(`UPDATE ${TABLES.outbox} SET format = ? WHERE seq = 1`, OUTBOX_FORMAT + 1);
		await db.close();
		store = await open();
		expect(await rejection(store.outbox!.read(0, 10, context))).toMatchObject({
			code: "unavailable",
			message: expect.stringContaining(`format ${OUTBOX_FORMAT + 1}`),
		});
		expect(await rejection(store.outbox!.read(0, 10, context))).toMatchObject({ code: "unavailable" });
		await store.close(context);
	});
});
