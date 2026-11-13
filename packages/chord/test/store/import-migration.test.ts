// Tests of rows of an imported table brought to the recorded version (spec `docs/host-keyed/spec.md` §4): edits and
// data steps (`rows`, `update`) in order, `$v` and `json(...)` cell versions exact, an archive exported during a
// migration resumed, and a version outside the owner's history refused.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { hostKind, int, obj, opt, str } from "../../src/contracts/index.ts";
import type { TableRecord } from "../../src/store/catalog.ts";
import { eq } from "../../src/store/expression.ts";
import { host } from "../../src/store/host-column.ts";
import { migrateRows } from "../../src/store/import-migration.ts";
import { json } from "../../src/store/json-column.ts";
import { defineTable, type TableDefinition } from "../../src/store/table.ts";
import { evolveTable } from "../../src/store/table-evolve.ts";

const Session = hostKind("session", { id: str() });

const V1 = defineTable("labels", {
	version: 1,
	columns: { session: host(Session), label: str(), n: int(), meta: opt(json(obj({ a: int() }), { version: 1 })) },
	key: ["session", "label"],
});
const V2 = evolveTable(V1, (t) =>
	t
		.rename("n", "count")
		.add("color", str({ default: "red" }))
		.rows((row) => ({ count: row.count * 2 })),
);
const V3 = evolveTable(V2, (t) =>
	t.update({ where: (row) => eq(row.label, "a"), set: { color: "blue" } }).drop("meta"),
);

const TABLE = "app.s:labels";

/** `definition` as the store records it, `state` given. */
function recorded(definition: TableDefinition, state: "ready" | "migrating" = "ready"): TableRecord {
	const { version, record: columns, key, fingerprint } = definition;
	return { table: TABLE, version, state, columns, key, fingerprint, indexes: Object.fromEntries(definition.indexes) };
}

/** The `table` write of `definition` (with `columns` of another layout, for a `migrating` one). */
function tableWrite(definition: TableDefinition, state: "ready" | "migrating" = "ready", layout = definition) {
	const { version, fingerprint } = definition;
	return {
		kind: "table",
		table: TABLE,
		version,
		state,
		columns: layout.record,
		key: layout.key,
		fingerprint,
	} as const;
}

/** A `put` of S1's `label` at `$v` `version`. */
function put(row: { readonly [column: string]: unknown }, version: number, columns: { [column: string]: number } = {}) {
	return { kind: "put", table: TABLE, row: { session: "session|S1", ...row }, version, columns } as never;
}

describe("migrated rows", () => {
	it("go through each version's edits and data step, with `$v` and json cell versions exact", () => {
		const rows = migrateRows(
			tableWrite(V1),
			[put({ label: "a", n: 1, meta: { a: 1 } }, 1, { meta: 1 }), put({ label: "b", n: 2 }, 1)],
			V3,
			recorded(V3),
			context,
		);
		expect(rows.map(({ row, version, columns }) => ({ row, version, columns }))).toEqual([
			{ row: { session: "session|S1", label: "a", count: 2, color: "blue" }, version: 3, columns: {} },
			{ row: { session: "session|S1", label: "b", count: 4, color: "red" }, version: 2, columns: {} },
		]);
	});

	it("stop at the version the store records", () => {
		const [row] = migrateRows(
			tableWrite(V1),
			[put({ label: "a", n: 1, meta: { a: 1 } }, 1, { meta: 1 })],
			V3,
			recorded(V2),
			context,
		);
		expect(row).toMatchObject({
			row: { label: "a", count: 2, color: "red", meta: { a: 1 } },
			version: 2,
			columns: { meta: 1 },
		});
	});

	it("resume an archive exported during a migration: rows already stamped are not patched again", () => {
		const step = V2.evolution!.migration.step!.table;
		const rows = migrateRows(
			tableWrite(V2, "migrating", step),
			[put({ label: "a", count: 1, color: "red" }, 1), put({ label: "b", count: 10, color: "red" }, 2)],
			V2,
			recorded(V2),
			context,
		);
		expect(rows.map(({ row }) => row.count)).toEqual([2, 10]);
	});

	it("refuse a version the owner's history does not have", () => {
		const unknown = { ...tableWrite(V1), version: 7 } as const;
		expect(() => migrateRows(unknown, [], V3, recorded(V3), context)).toThrow("is not in its owner's history");
	});

	it("give a json(...) cell a data step sets the column's version then, and keep an untouched cell's", () => {
		const W1 = defineTable("notes", {
			version: 1,
			columns: { session: host(Session), id: str(), meta: json(obj({ a: int() }), { version: 1 }) },
			key: ["session", "id"],
		});
		const W2 = evolveTable(W1, (t) =>
			t
				.json(
					"meta",
					json(obj({ a: int(), b: int() }), {
						version: 2,
						migrate: (old) => ({ ...(old as { a: number }), b: 0 }),
					}),
				)
				.rows((row) => (row.id === "x" ? { meta: { a: row.meta.a, b: 9 } } : {})),
		);
		const write = {
			kind: "table",
			table: TABLE,
			version: 1,
			state: "ready",
			columns: W1.record,
			key: W1.key,
			fingerprint: W1.fingerprint,
		} as const;
		const rows = migrateRows(
			write,
			[put({ id: "x", meta: { a: 1 } }, 1, { meta: 1 }), put({ id: "y", meta: { a: 2 } }, 1, { meta: 1 })],
			W2,
			recorded(W2),
			context,
		);
		expect(rows.map(({ row, version, columns }) => ({ row, version, columns }))).toEqual([
			{ row: { session: "session|S1", id: "x", meta: { a: 1, b: 9 } }, version: 2, columns: { meta: 2 } },
			{ row: { session: "session|S1", id: "y", meta: { a: 2 } }, version: 2, columns: { meta: 1 } },
		]);
	});
});
