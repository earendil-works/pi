// Tests of the store for adapters (slice 6b §2.1): an owner's declared tables, rows deleted in a step by key and by an
// indexed condition, recorded as the `delete` and `deleteWhere` writes a replica applies with their counts.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { int, str } from "../../src/contracts/index.ts";
import { StoreOwnerTables } from "../../src/store/adapter.ts";
import { applyBatch } from "../../src/store/apply-batch.ts";
import type { StagedWrite, Step } from "../../src/store/step.ts";
import type { ChordStore } from "../../src/store/store.ts";
import { defineTable } from "../../src/store/table.ts";
import type { TableWrite } from "../../src/store/table-writes.ts";
import { exported, memoryStore, rejection } from "../support.ts";

const OPEN = { admit: () => true, adopt: () => {} };

const Items = defineTable("items", {
	version: 1,
	columns: { id: int(), group_id: int(), name: str() },
	key: ["id"],
	indexes: { by_group: ["group_id"] },
});

/** A store with an outbox and `Items` declared and prepared under `app.adapter`, three rows in two groups. */
async function adapted() {
	const store = await memoryStore({ outbox: true });
	const tables = new StoreOwnerTables(store, "app.adapter", { label: "adapter" });
	const items = tables.declare(Items);
	await tables.prepare(context);
	const rows = [
		{ id: 1, group_id: 7, name: "a" },
		{ id: 2, group_id: 7, name: "b" },
		{ id: 3, group_id: 8, name: "c" },
	].map((row) => items.encode(row));
	await store.commit([step(async (each) => Promise.all(rows.map((row) => items.put(each, row))))], OPEN, context);
	return { store, items };
}

/** A staged write applying `apply` in the step (an adapter's composite). */
function step(apply: (step: Step) => Promise<readonly TableWrite[]>): StagedWrite {
	return { order: "write", apply };
}

/** The ids of `store`'s items, by id. */
async function ids(store: ChordStore): Promise<unknown[]> {
	return store.read((executor) => executor.all('SELECT id FROM "app.adapter:items" ORDER BY id'), context);
}

describe("an owner table's deletions", () => {
	it("delete by key and by condition in a step, recorded with their counts; an absent key counts 0", async () => {
		const { store, items } = await adapted();
		const key = items.encodeKey({ id: 3 });
		const absent = items.encodeKey({ id: 9 });
		let recorded: TableWrite[] = [];
		await store.commit(
			[
				step(async (each) => {
					recorded = [
						await items.deleteWhere(each, { eq: ["group_id", 7] }),
						await items.delete(each, key),
						await items.delete(each, absent),
					];
					return recorded;
				}),
			],
			OPEN,
			context,
		);
		expect(recorded).toEqual([
			{ kind: "deleteWhere", table: "app.adapter:items", where: { eq: ["group_id", 7] }, count: 2 },
			{ kind: "delete", table: "app.adapter:items", key: { id: 3 }, count: 1 },
			{ kind: "delete", table: "app.adapter:items", key: { id: 9 }, count: 0 },
		]);
		expect(await ids(store)).toEqual([]);
		expect((await store.outbox!.read(store.lastSeq - 1, 10, context))[0]!.writes).toEqual(recorded);
	});

	it("travel to a replica, which applies them with the same counts", async () => {
		const { store, items } = await adapted();
		await store.commit(
			[step(async (each) => [await items.deleteWhere(each, { eq: ["group_id", 7] })])],
			OPEN,
			context,
		);
		const replica = await memoryStore();
		await applyBatch(replica, await store.outbox!.read(store.outbox!.floor, 100, context), context);
		expect(await ids(replica)).toEqual([{ id: 3 }]);
		expect(await exported(replica)).toEqual(await exported(store));
	});

	it("refuse a key that is not one of the table's at staging", async () => {
		const { items } = await adapted();
		for (const key of [{ id: "x" }, { id: 1, name: "a" }, {}]) {
			expect(await rejection(Promise.resolve().then(() => items.encodeKey(key)))).toMatchObject({
				code: "invalid",
				reason: "args",
			});
		}
	});
});
