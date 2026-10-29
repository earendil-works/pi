// Tests of a table's history (slice 6a §9): what an activation does with the recorded version: create, use, migrate
// from there (resuming a `migrating` one), or refuse a version the code cannot reach.

import { describe, expect, it } from "vitest";
import { int, obj, str } from "../../../src/next/contracts/index.ts";
import type { TableRecord } from "../../../src/next/store/catalog.ts";
import { json } from "../../../src/next/store/json-column.ts";
import { defineTable, type TableDefinition } from "../../../src/next/store/table.ts";
import { evolveTable } from "../../../src/next/store/table-evolve.ts";
import { planTable } from "../../../src/next/store/table-history.ts";

const V1 = defineTable("edits", { version: 1, columns: { id: str(), at: int() }, key: ["id"] });
const V2 = evolveTable(V1, (t) => t.add("dir", str({ default: "" })).rows(() => ({})));
const V3 = evolveTable(V2, (t) => t.index("by_at", ["at"]));

/** The record of `definition` in `state`. */
function recorded(definition: TableDefinition, state: "ready" | "migrating" = "ready"): TableRecord {
	const { version, record: columns, key, fingerprint } = definition;
	return { table: "t", version, state, columns, key, fingerprint, indexes: {} };
}

describe("plans", () => {
	it("create a table the store does not have; use one recorded at the newest version", () => {
		expect(planTable(V3, undefined, "app.store")).toEqual({ kind: "create" });
		expect(planTable(V3, recorded(V3), "app.store")).toEqual({ kind: "ready" });
	});

	it("migrate through every later version, oldest first; resume a version recorded migrating", () => {
		expect(planTable(V3, recorded(V1), "app.store")).toEqual({ kind: "migrate", versions: [V2, V3], first: "begin" });
		expect(planTable(V3, recorded(V2, "migrating"), "app.store")).toEqual({
			kind: "migrate",
			versions: [V2, V3],
			first: "resume",
		});
	});
});

describe("refusals", () => {
	it.each<[string, TableDefinition, TableRecord, string]>([
		["a newer version (old code)", V2, recorded(V3), "version 3, newer than the code's 2"],
		[
			"a version older than a new base",
			defineTable("edits", { version: 7, columns: { id: str() }, key: ["id"] }),
			recorded(V3),
			"older than the history's base 7",
		],
		[
			"a history edited in place",
			evolveTable(V1, (t) => t.add("dir", str({ default: "x" }))),
			recorded(V2),
			"recorded with another definition",
		],
		[
			"a json(...) column with another schema at the same version (D9)",
			defineTable("notes", {
				version: 1,
				columns: { id: str(), meta: json(obj({ b: int() }), { version: 1 }) },
				key: ["id"],
			}),
			recorded(
				defineTable("notes", {
					version: 1,
					columns: { id: str(), meta: json(obj({ a: int() }), { version: 1 }) },
					key: ["id"],
				}),
			),
			"recorded with another definition",
		],
		["a migrating version without a data step", V3, recorded(V3, "migrating"), "has no data step to resume"],
	])("%s", (_, definition, record, message) => {
		expect(() => planTable(definition, record, "app.store")).toThrow(message);
	});
});
