// Table handles (slice 6a §7): reads outside a transaction, and cells the code cannot read.

import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { bool, int, obj, opt, str } from "../../../src/next/contracts/index.ts";
import { eq, gte, isNull, prefix } from "../../../src/next/store/expression.ts";
import { json } from "../../../src/next/store/json-column.ts";
import { query } from "../../../src/next/store/query.ts";
import type { StagedWrite } from "../../../src/next/store/step.ts";
import type { ChordStore } from "../../../src/next/store/store.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import { TableChanges } from "../../../src/next/store/table-changes.ts";
import type { TableHandle } from "../../../src/next/store/table-handle.ts";
import { memoryStore, rejection, tableIn, tableOwner } from "../support.ts";

const Edits = defineTable("edits", {
	version: 1,
	columns: {
		id: str(),
		path: str(),
		at: int(),
		done: bool({ default: false }),
		note: opt(str()),
		meta: json(obj({ a: int() }), { version: 1 }),
	},
	key: ["id"],
	indexes: { by_path: ["path", "at"] },
});

let store: ChordStore;
afterEach(async () => {
	await store?.close(context);
});

/** A table with `count` rows e0..e(count-1): path `p/<i % 3>`, at `i`. */
async function filled(count: number, owner = tableOwner()): Promise<TableHandle> {
	store = await memoryStore();
	const edits = await tableIn(store, Edits, owner);
	const staged: StagedWrite[] = [];
	const changes = new TableChanges(edits, staged);
	for (let i = 0; i < count; i++)
		changes.put({ id: `e${String(i).padStart(3, "0")}`, path: `p/${i % 3}`, at: i, meta: { a: i } });
	await store.commit(staged, { admit: () => true, adopt: () => {} }, context);
	return edits;
}

describe("reads outside a transaction", () => {
	it("get takes a key object and reads committed rows as stored", async () => {
		const edits = await filled(3);
		expect(await edits.get({ id: "e001" }, context)).toEqual({
			id: "e001",
			path: "p/1",
			at: 1,
			done: false,
			meta: { a: 1 },
		});
		expect(await edits.get({ id: "nope" }, context)).toBeUndefined();
		expect(await rejection(edits.get({ id: "e001", path: "x" }, context))).toMatchObject({
			code: "invalid",
			reason: "args",
		});
	});

	it("page fetches limit + 1 for next, and the cursor continues in order with the key tie-break", async () => {
		const edits = await filled(10);
		const q = query(Edits)
			.where((e) => prefix(e.path, "p/"))
			.orderBy((e) => e.path, "desc");
		const seen: string[] = [];
		let after: string | undefined;
		do {
			const page = await edits.page(q, 3, context, after === undefined ? {} : { after });
			expect(page.items.length).toBeLessThanOrEqual(3);
			seen.push(...page.items.map((row) => `${row.path}:${row.id}`));
			after = page.next;
		} while (after !== undefined);
		const all = (await edits.page(q, 100, context)).items.map((row) => `${row.path}:${row.id}`);
		expect(seen).toEqual(all);
		expect(all.slice(0, 4)).toEqual(["p/2:e008", "p/2:e005", "p/2:e002", "p/1:e007"]);
		expect((await edits.page(q, 4, context)).next).toBeDefined();
		expect((await edits.page(query(Edits), 10, context)).next).toBeUndefined();
	});

	it("rows reads every page; count counts", async () => {
		const edits = await filled(250);
		const ids: string[] = [];
		for await (const row of edits.rows(
			query(Edits).where((e) => gte(e.at, 10)),
			context,
		))
			ids.push(row.id as string);
		expect(ids).toHaveLength(240);
		expect(ids[0]).toBe("e010");
		expect(
			await edits.count(
				query(Edits).where((e) => eq(e.path, "p/0")),
				context,
			),
		).toBe(84);
		expect(
			await edits.count(
				query(Edits).where((e) => isNull(e.note)),
				context,
			),
		).toBe(250);
	});

	it("refuses a query of another table, a bad limit and a foreign cursor before the backend", async () => {
		const edits = await filled(1);
		const Other = defineTable("other", { version: 1, columns: { id: str() }, key: ["id"] });
		expect(await rejection(edits.page(query(Other) as never, 1, context))).toMatchObject({ reason: "args" });
		expect(await rejection(edits.page(query(Edits), 0, context))).toMatchObject({ reason: "args" });
		expect(await rejection(edits.page(query(Edits), 1.5, context))).toMatchObject({ reason: "args" });
		expect(await rejection(edits.page(query(Edits), 1, context, { after: "x" }))).toMatchObject({ reason: "args" });
	});

	it("reads go through the store's guard: refused once the store closed", async () => {
		const edits = await filled(1);
		await store.close(context);
		expect(await rejection(edits.get({ id: "e000" }, context))).toMatchObject({ code: "released" });
	});
});

describe("unreadable cells", () => {
	it("a json cell of a newer version fails the owner and the read, the data intact", async () => {
		const owner = tableOwner();
		const edits = await filled(1, owner);
		await store.read((executor) => executor.run(`UPDATE "app.store:edits" SET "meta$v" = 2`), context);
		const error = await rejection(edits.get({ id: "e000" }, context));
		expect(error).toMatchObject({ code: "unavailable" });
		expect(owner.failures).toHaveLength(1);
		expect(await store.read((executor) => executor.get(`SELECT meta FROM "app.store:edits"`), context)).toEqual({
			meta: '{"a":0}',
		});
	});
});
