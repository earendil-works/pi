// Column sets (slice 14 §5): `defineColumns` checks its own declaration; a table that `exposes` a set has its
// columns with the same definition, the same key, and an index path for each index the set declares; `evolveTable`
// carries the set over, replaces it or drops it.

import { describe, expect, it } from "vitest";
import { bool, hostKind, int, obj, opt, str } from "../../src/contracts/index.ts";
import { defineColumns } from "../../src/store/column-set.ts";
import { host } from "../../src/store/host-column.ts";
import { json } from "../../src/store/json-column.ts";
import { defineTable } from "../../src/store/table.ts";
import { evolveTable } from "../../src/store/table-evolve.ts";

const Session = hostKind("session", { id: str() });
const Columns = defineColumns("sessions.columns", {
	columns: { id: host(Session), app: str(), private: bool(), archivedAt: opt(int()) },
	key: ["id"],
	indexes: { ofApp: ["app"] },
});

describe("defineColumns", () => {
	it("keeps its columns, key and indexes, and hands out references tagged with its name", () => {
		expect([...Columns.byName.keys()]).toEqual(["id", "app", "private", "archivedAt"]);
		expect(Columns.key).toEqual(["id"]);
		expect([...Columns.indexes]).toEqual([["ofApp", ["app"]]]);
		expect([Columns.refs.app.column, Columns.refs.app.set]).toEqual(["app", "sessions.columns"]);
	});

	it("refuses a json column, a key or an index of a column it has not, and a bad name", () => {
		const meta = json(obj({}), { version: 1 });
		expect(() => defineColumns("x", { columns: { id: str(), meta } as never, key: ["id"] as never })).toThrow(
			'column "meta": json(...) is not in a column set',
		);
		expect(() => defineColumns("x", { columns: { id: str() }, key: ["nope"] as never })).toThrow('no column "nope"');
		expect(() => defineColumns("x", { columns: { id: str() }, key: ["id"], indexes: { a: ["b"] as never } })).toThrow(
			'index "a": no column "b"',
		);
		expect(() => defineColumns("Bad Name", { columns: { id: str() }, key: ["id"] })).toThrow("expected lowercase");
	});
});

describe("exposes", () => {
	const table = (columns: object, key: readonly string[], indexes: object = { by_app: ["app", "id"] }) =>
		defineTable("rows", { version: 1, columns, key, indexes, exposes: Columns } as never);

	it("takes a table that spreads the set's columns, with the key and an index path per declared index", () => {
		const Rows = table({ ...Columns.columns, cwd: str() }, ["id"]);
		expect(Rows.exposes).toBe(Columns);
	});

	it("is no part of the table's fingerprint", () => {
		const options = {
			version: 1,
			columns: { ...Columns.columns },
			key: ["id"],
			indexes: { by_app: ["app"] },
		} as const;
		expect(defineTable("rows", { ...options, exposes: Columns }).fingerprint).toBe(
			defineTable("rows", options).fingerprint,
		);
	});

	it("refuses a missing column, another type, another key and an index the table lacks", () => {
		const { app: _app, ...withoutApp } = Columns.columns;
		expect(() => table({ ...withoutApp, cwd: str() }, ["id"], {})).toThrow('the table has no column "app"');
		expect(() => table({ ...Columns.columns, app: int() }, ["id"])).toThrow(
			'column "app" is declared differently in the table',
		);
		expect(() => table({ ...Columns.columns, n: int() }, ["n"])).toThrow("the keys differ");
		expect(() => table({ ...Columns.columns }, ["id"], {})).toThrow(
			'index "ofApp" is no leading prefix of the key or of an index of the table',
		);
	});
});

describe("evolveTable", () => {
	const Rows = defineTable("rows", {
		version: 1,
		columns: { ...Columns.columns },
		key: ["id"],
		indexes: { by_app: ["app"] },
		exposes: Columns,
	});

	it("carries the set over, replaces it, or drops it", () => {
		expect(evolveTable(Rows, (t) => t.add("cwd", opt(str()))).exposes).toBe(Columns);
		expect(evolveTable(Rows, (t) => t.add("cwd", opt(str())), { exposes: "none" }).exposes).toBeUndefined();
		const Narrow = defineColumns("sessions.columns", { columns: { id: host(Session), app: str() }, key: ["id"] });
		expect(evolveTable(Rows, (t) => t.drop("private"), { exposes: Narrow }).exposes).toBe(Narrow);
	});

	it("refuses a version that no longer has a column of the set it exposes", () => {
		expect(() => evolveTable(Rows, (t) => t.drop("private"))).toThrow('the table has no column "private"');
	});
});
