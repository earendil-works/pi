// A transaction's table writes (slice 6a §6, §7): staging, and the `tx.get` overlay over committed rows.

import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { int, opt, str } from "../../../src/next/contracts/index.ts";
import { add, eq, prefix } from "../../../src/next/store/expression.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import type { ChordStore } from "../../../src/next/store/store.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import { TableChanges } from "../../../src/next/store/table-changes.ts";
import { memoryStore, rejection, tableIn } from "../support.ts";

const Edits = defineTable("edits", {
	version: 1,
	columns: { id: str(), path: str(), hits: int({ default: 0 }), note: opt(str()) },
	key: ["id"],
});
const FENCE = { admit: () => true, adopt: () => {} };

let store: ChordStore;
afterEach(async () => {
	await store?.close(context);
});

/** Changes to a table holding `e1` (committed); the staged list they append to. */
async function seeded(): Promise<{ readonly changes: TableChanges; readonly staged: StagedWrite[] }> {
	store = await memoryStore();
	const edits = await tableIn(store, Edits);
	const seed: StagedWrite[] = [];
	new TableChanges(edits, seed).put({ id: "e1", path: "a/1", hits: 1 });
	await store.commit(seed, FENCE, context);
	const staged: StagedWrite[] = [];
	return { changes: new TableChanges(edits, staged), staged };
}

describe("staging", () => {
	it("checks at the call, appends in order, and touches no backend before the commit", async () => {
		const { changes, staged } = await seeded();
		changes.put({ id: "e2", path: "a/2" });
		expect(() => changes.put({ id: "e3" })).toThrow('column "path" is missing');
		expect(() => changes.update({ id: "e1" }, { id: "x" })).toThrow("cannot change");
		changes.update({ id: "e1" }, { note: "n" });
		changes.delete({ id: "e9" });
		expect(staged).toHaveLength(3);
		expect(
			await store.read((executor) => executor.get(`SELECT count(*) AS n FROM "app.store:edits"`), context),
		).toEqual({ n: 1 });
	});
});

describe("the tx.get overlay", () => {
	it("replays the transaction's own put, update and delete over the committed row", async () => {
		const { changes } = await seeded();
		changes.update({ id: "e1" }, (e: { hits: never }) => ({ hits: add(e.hits, 2) }));
		expect(await changes.get({ id: "e1" }, context)).toEqual({ id: "e1", path: "a/1", hits: 3 });
		changes.update({ id: "e1" }, { note: "n" });
		expect(await changes.get({ id: "e1" }, context)).toEqual({ id: "e1", path: "a/1", hits: 3, note: "n" });
		changes.delete({ id: "e1" });
		expect(await changes.get({ id: "e1" }, context)).toBeUndefined();
		changes.put({ id: "e1", path: "b" });
		changes.update({ id: "e1" }, (e: { hits: never }) => ({ hits: add(e.hits, 1) }));
		expect(await changes.get({ id: "e1" }, context)).toEqual({ id: "e1", path: "b", hits: 1 });
	});

	it("an update of an absent key changes nothing", async () => {
		const { changes } = await seeded();
		changes.update({ id: "e9" }, { note: "n" });
		expect(await changes.get({ id: "e9" }, context)).toBeUndefined();
	});

	it("is refused on a table after an updateWhere or deleteWhere (W10); other tables are unaffected", async () => {
		const { changes } = await seeded();
		expect(await changes.get({ id: "e1" }, context)).toBeDefined();
		changes.updateWhere((e: { path: never }) => prefix(e.path, "a/"), { note: "bulk" });
		expect(await rejection(changes.get({ id: "e1" }, context))).toMatchObject({
			code: "invalid",
			reason: "read_after_bulk",
		});
		const other = new TableChanges(changes.handle, []);
		other.deleteWhere((e: { id: never }) => eq(e.id, "x"));
		expect(await rejection(other.get({ id: "e1" }, context))).toMatchObject({ reason: "read_after_bulk" });
		expect(await new TableChanges(changes.handle, []).get({ id: "e1" }, context)).toBeDefined();
	});
});
