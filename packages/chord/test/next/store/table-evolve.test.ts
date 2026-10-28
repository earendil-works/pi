// Tests of `evolveTable` (slice 6a §9): versions appended and materialized at declaration, the edits recorded before
// and after the data step, their checks, the editor rule shared with contracts, and the types along the chain.

import { describe, expect, expectTypeOf, it } from "vitest";
import { int, obj, opt, str } from "../../../src/next/contracts/index.ts";
import type { RowOf } from "../../../src/next/store/columns.ts";
import { add, eq } from "../../../src/next/store/expression.ts";
import { json } from "../../../src/next/store/json-column.ts";
import { defineTable, type TableDefinition } from "../../../src/next/store/table.ts";
import { evolveTable } from "../../../src/next/store/table-evolve.ts";

const EditsV1 = defineTable("edits", {
	version: 1,
	columns: { id: str(), file: str(), at: int(), meta: opt(json(obj({ a: int() }), { version: 1 })) },
	key: ["id"],
	indexes: { by_file: ["file", "at"] },
});

describe("versions", () => {
	it("each evolveTable appends version + 1, materialized and fingerprinted, linked to the one before", () => {
		const V2 = evolveTable(EditsV1, (t) => t.add("dir", str({ default: "" })));
		const V3 = evolveTable(V2, (t) => t.index("by_dir", ["dir"]));
		expect([V2.version, V3.version]).toEqual([2, 3]);
		expect(V3.evolution?.previous).toBe(V2);
		expect(V2.evolution?.previous).toBe(EditsV1);
		expect(new Set([EditsV1.fingerprint, V2.fingerprint, V3.fingerprint]).size).toBe(3);
		expect(V3.indexes).toEqual(
			new Map([
				["by_file", ["file", "at"]],
				["by_dir", ["dir"]],
			]),
		);
		expectTypeOf(V3.version).toEqualTypeOf<3>();
	});

	it("the edit must return the editor it was given (contracts' rule)", () => {
		expect(() => evolveTable(EditsV1, () => ({}) as never)).toThrow(
			"edits: evolveTable must return the editor it was given",
		);
	});
});

describe("edits", () => {
	it("are recorded before and after the data step; the step reads the columns as they stand there", () => {
		const V2 = evolveTable(EditsV1, (t) =>
			t
				.rename("file", "path")
				.add("dir", str({ default: "" }))
				.rows((row) => ({ dir: row.path }))
				.drop("at")
				.index("by_dir", ["dir"]),
		);
		const migration = V2.evolution!.migration;
		expect(migration.before).toEqual([
			{ kind: "rename", from: "file", to: "path" },
			{ kind: "add", name: "dir", column: { type: "str", default: "" } },
		]);
		expect(migration.after).toEqual([
			{ kind: "dropIndex", name: "by_file" },
			{ kind: "drop", name: "at" },
			{ kind: "index", name: "by_dir", columns: ["dir"] },
		]);
		const step = migration.step!;
		expect(step.kind).toBe("rows");
		expect(step.table.columns.map(({ name }) => name)).toEqual(["id", "path", "at", "meta", "dir"]);
		expect(V2.columns.map(({ name }) => name)).toEqual(["id", "path", "meta", "dir"]);
		expect(V2.indexes).toEqual(new Map([["by_dir", ["dir"]]]));
	});

	it("a rename carries the key and the indexes", () => {
		const V2 = evolveTable(EditsV1, (t) => t.rename("id", "uid").rename("file", "path"));
		expect(V2.key).toEqual(["uid"]);
		expect(V2.indexes).toEqual(new Map([["by_file", ["path", "at"]]]));
		expectTypeOf<RowOf<typeof V2 extends TableDefinition<infer C> ? C : never>>().toEqualTypeOf<
			{ uid: string; path: string; at: number } & { meta?: { a: number } }
		>();
	});

	it("an update step is compiled at declaration against the columns there", () => {
		const V2 = evolveTable(EditsV1, (t) =>
			t.update({ where: (e) => eq(e.file, "x"), set: (e) => ({ at: add(e.at, 1) }) }),
		);
		expect(V2.evolution!.migration.step).toMatchObject({
			kind: "update",
			where: { eq: ["file", "x"] },
			set: { at: { add: [{ col: "at" }, 1] } },
		});
		expect(() =>
			evolveTable(EditsV1, (t) =>
				// @ts-expect-error: key columns cannot change (rule 13)
				t.update({ set: { id: "x" } }),
			),
		).toThrow('key column "id" cannot change');
	});

	it("a json edit changes the column's version and keeps its nullability", () => {
		const V2 = evolveTable(EditsV1, (t) =>
			t.json(
				"meta",
				json(obj({ a: int(), b: int() }), { version: 2, migrate: (old) => ({ ...(old as { a: number }), b: 0 }) }),
			),
		);
		expect(V2.byName.get("meta")).toMatchObject({ type: "json", optional: true });
		expect(V2.evolution!.migration.before).toEqual([
			{ kind: "json", name: "meta", column: expect.objectContaining({ type: "json", optional: true, version: 2 }) },
		]);
		expectTypeOf<RowOf<typeof V2 extends TableDefinition<infer C> ? C : never>>().toEqualTypeOf<
			{ id: string; file: string; at: number } & { meta?: { a: number; b: number } }
		>();
	});
});

describe("checks", () => {
	it("a rename may change only the case of its own column", () => {
		expect(evolveTable(EditsV1, (t) => t.rename("at", "AT")).byName.has("AT")).toBe(true);
	});

	it.each<[string, () => unknown, string]>([
		["rename to an existing column", () => evolveTable(EditsV1, (t) => t.rename("file", "at")), 'column "at" exists'],
		[
			"rename an unknown column",
			() => evolveTable(EditsV1, (t) => t.rename("nope" as "file", "x")),
			'no column "nope"',
		],
		[
			"add a column without opt(...) or a default",
			// @ts-expect-error: an added column is opt(...) or has a default
			() => evolveTable(EditsV1, (t) => t.add("dir", str())),
			"needs opt(...) or a default",
		],
		[
			"drop a key column",
			// @ts-expect-error: a key column cannot be dropped
			() => evolveTable(EditsV1, (t) => t.drop("id")),
			'"id" is a key column',
		],
		[
			"rename after a drop",
			// @ts-expect-error: rename comes before drop, index and dropIndex
			() => evolveTable(EditsV1, (t) => t.drop("at").rename("file", "path")),
			"rename comes before the data step",
		],
		[
			"a second data step",
			// @ts-expect-error: at most one data step
			() => evolveTable(EditsV1, (t) => t.rows(() => ({})).rows(() => ({}))),
			"rows comes before the data step",
		],
		["an existing index", () => evolveTable(EditsV1, (t) => t.index("by_file", ["at"])), 'index "by_file" exists'],
		["dropIndex of an unknown index", () => evolveTable(EditsV1, (t) => t.dropIndex("nope")), 'no index "nope"'],
		[
			"an index over an opt(...) column",
			// @ts-expect-error: index columns are non-opt str() or int() columns
			() => evolveTable(EditsV1, (t) => t.index("by_meta", ["meta"])),
			"is not a non-opt str() or int() column",
		],
		[
			"a json edit of a scalar column",
			// @ts-expect-error: only json(...) columns take a json edit
			() => evolveTable(EditsV1, (t) => t.json("file", json(obj({}), { version: 2 }))),
			"is not a json(...) column",
		],
		[
			"a json edit changing the schema at the cell's version (D9)",
			() => evolveTable(EditsV1, (t) => t.json("meta", json(obj({ b: str() }), { version: 1 }))),
			"changes its schema at version 1",
		],
		[
			"a json edit going back a version",
			() =>
				evolveTable(
					evolveTable(EditsV1, (t) => t.json("meta", json(obj({ a: int() }), { version: 2 }))),
					(t) => t.json("meta", json(obj({ a: int() }), { version: 1 })),
				),
			"goes back from version 2",
		],
		[
			"an add colliding by case with a column a later drop removes",
			() => evolveTable(EditsV1, (t) => t.add("File", str({ default: "" })).drop("file")),
			'column "file" exists',
		],
		[
			"a rename colliding by case with another column",
			() => evolveTable(EditsV1, (t) => t.rename("at", "FILE")),
			'column "file" exists',
		],
		[
			"a name folding to a column's only beyond ASCII (SQLite folds ASCII): the name rule, not a collision",
			() => {
				const Kinds = defineTable("kinds", { version: 1, columns: { id: str(), kind: str() }, key: ["id"] });
				return evolveTable(Kinds, (t) => t.add("\u212Aind", opt(str())));
			},
			"expected [A-Za-z_][A-Za-z0-9_]*",
		],
		[
			"an index on a column missing at that edit, though a later dropIndex removes the index",
			// @ts-expect-error: index columns are the table's columns at that edit
			() => evolveTable(EditsV1, (t) => t.index("bad", ["missing"]).dropIndex("bad")),
			'index "bad": no column "missing"',
		],
		[
			"an index on a column dropped before it",
			// @ts-expect-error: the dropped column is gone at this edit
			() => evolveTable(EditsV1, (t) => t.drop("at").index("by_at", ["at"])),
			'index "by_at": no column "at"',
		],
		[
			"a rename to a name breaking the column name rule, though a later rename fixes it",
			() => evolveTable(EditsV1, (t) => t.rename("at", "bad\u0000name").rename("bad\u0000name", "when")),
			'rename: column "bad\u0000name": expected [A-Za-z_][A-Za-z0-9_]*',
		],
		[
			"a rename to a name breaking the column name rule, though a later drop removes it",
			() => evolveTable(EditsV1, (t) => t.rename("at", "1st").drop("1st")),
			'rename: column "1st": expected',
		],
		[
			"an index name outside [a-z0-9_]+",
			() => evolveTable(EditsV1, (t) => t.index("By", ["file"])),
			"expected [a-z0-9_]+",
		],
	])("refuses %s at declaration", (_, declare, message) => {
		expect(declare).toThrow(message);
	});
});
