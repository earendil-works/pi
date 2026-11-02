// Tests of the JavaScript evaluator of the table vocabulary, and that it agrees with SQLite on the same nodes.
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { bool, int, num, obj, opt, str } from "../../../src/next/contracts/index.ts";
import { applySet, type EvaluatedRow, matches } from "../../../src/next/store/evaluate.ts";
import {
	add,
	and,
	coalesce,
	compileSet,
	compileWhere,
	concat,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	lte,
	max,
	min,
	ne,
	not,
	or,
	prefix,
	replacePrefix,
	sub,
	type WhereNode,
	when,
} from "../../../src/next/store/expression.ts";
import { json } from "../../../src/next/store/json-column.ts";
import type { ColumnRefs } from "../../../src/next/store/query.ts";
import { createTableSql, TableSql, whereSql } from "../../../src/next/store/sql.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import type { SqliteValue } from "../../../src/sqlite/index.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";

const T = defineTable("t", {
	version: 1,
	columns: {
		id: str(),
		path: str(),
		n: int(),
		x: num(),
		b: bool(),
		note: opt(str()),
		count: opt(int()),
		meta: opt(json(obj({ a: int() }), { version: 1 })),
	},
	key: ["id"],
});
type C = typeof T extends { "~columns"?: infer X } ? NonNullable<X> : never;
const refs = T.refs as ColumnRefs<C>;
const args = expect.objectContaining({ code: "invalid", reason: "args" });
describe("the evaluator", () => {
	const row: EvaluatedRow = { id: "r", path: "a/x", n: 2, x: 1, b: true, count: 3 };

	it("follows SQL's NULL rules: a comparison with NULL never matches, not and ne included", () => {
		const where = (condition: unknown) => compileWhere(T, condition, "where");
		expect(matches(where(eq(refs.note, "a")), row)).toBe(false);
		expect(matches(where(ne(refs.note, "a")), row)).toBe(false);
		expect(matches(where(not(eq(refs.note, "a"))), row)).toBe(false);
		expect(matches(where(or(isNull(refs.note), ne(refs.note, "a"))), row)).toBe(true);
		expect(matches(where(and()), row)).toBe(true);
		expect(matches(where(or()), row)).toBe(false);
		expect(matches(where(inArray(refs.n, [])), row)).toBe(false);
	});

	it("evaluates every right side against the row before (a swap)", () => {
		const Swap = defineTable("s", { version: 1, columns: { id: str(), a: str(), b: str() }, key: ["id"] });
		const set = compileSet(
			Swap,
			{ a: (Swap.refs as { b: unknown }).b, b: (Swap.refs as { a: unknown }).a },
			"update",
		);
		expect(applySet(set, { id: "1", a: "x", b: "y" }, "s")).toEqual({ id: "1", a: "y", b: "x" });
	});

	it("leaves a value without the prefix unchanged and refuses integers outside the safe range (rule 10)", () => {
		expect(applySet(compileSet(T, { path: replacePrefix(refs.path, "b/", "c/") }, "u"), row, "t").path).toBe("a/x");
		expect(applySet(compileSet(T, { path: replacePrefix(refs.path, "a/", "") }, "u"), row, "t").path).toBe("x");
		const big = { ...row, n: Number.MAX_SAFE_INTEGER };
		expect(() => applySet(compileSet(T, { n: add(refs.n, 1) }, "u"), big, "t")).toThrow(args);
	});
});

describe("one semantics: the evaluator agrees with SQLite", () => {
	const ROWS: EvaluatedRow[] = [
		{ id: "1", path: "a/x", n: 1, x: 0.5, b: true, note: "z", count: 1 },
		{ id: "2", path: "a/\u{1F600}", n: 2, x: 2, b: false },
		{ id: "3", path: "a\uFFFF", n: -3, x: -1, b: true, note: "" },
		{ id: "4", path: "b", n: 0, x: 0, b: false, count: 0 },
		{ id: "5", path: "", n: 9, x: 9.5, b: true, note: "a/" },
		{ id: "6", path: "\u{10FFFF}", n: 5, x: 1, b: false, count: -2 },
	];
	const CONDITIONS = [
		eq(refs.note, "z"),
		ne(refs.note, "z"),
		not(ne(refs.count, 0)),
		lt(refs.path, "a\uFFFF"),
		gte(refs.path, "a/\u{1F600}"),
		prefix(refs.path, "a"),
		prefix(refs.path, ""),
		prefix(refs.path, "\u{10FFFF}"),
		inArray(refs.path, ["b", "", "x"]),
		inArray(refs.b, [true]),
		or(isNull(refs.count), gt(refs.x, 1)),
		and(not(isNull(refs.note)), lte(refs.n, 1)),
		not(or(eq(refs.b, true), lt(refs.count, 0))),
	];

	async function table() {
		const db = await openNodeSqliteDatabase(":memory:");
		await db.run(createTableSql("t", T.record, T.key));
		const sql = new TableSql("t", T.columns, T.rows.physical, T.key);
		for (const row of ROWS) await db.run(sql.put, ...T.rows.put(row, 1).params);
		return { db, sql };
	}

	it("selects the rows the evaluator matches", async () => {
		const { db } = await table();
		for (const condition of CONDITIONS) {
			const node = compileWhere(T, condition, "where");
			const params: SqliteValue[] = [];
			const text = whereSql(node, params);
			const rows = await db.all<{ id: string }>(`SELECT id FROM t WHERE ${text} ORDER BY id`, ...params);
			const expected = ROWS.filter((row) => matches(node, row)).map(({ id }) => id);
			expect([JSON.stringify(node), rows.map(({ id }) => id)]).toEqual([JSON.stringify(node), expected]);
		}
		await db.close();
	});

	it("agrees on every operator's NULL truth under not, and, or and when", async () => {
		const PREDICATES = [
			eq(refs.note, "z"),
			ne(refs.note, "z"),
			lt(refs.count, 1),
			lte(refs.count, 0),
			gt(refs.note, "a"),
			gte(refs.count, 0),
			inArray(refs.note, ["z", ""]),
			inArray(refs.note, []),
			prefix(refs.note, "a"),
			prefix(refs.note, ""),
			isNull(refs.count),
		];
		const WRAPPED = PREDICATES.flatMap((p) => [
			p,
			not(p),
			and(p, eq(refs.b, true)),
			or(p, eq(refs.b, true)),
			not(and(p, eq(refs.b, true))),
			not(or(p, eq(refs.b, false))),
		]);
		const { db } = await table();
		for (const condition of WRAPPED) {
			const node = compileWhere(T, condition, "where");
			const params: SqliteValue[] = [];
			const text = whereSql(node, params);
			const rows = await db.all<{ id: string }>(`SELECT id FROM t WHERE ${text} ORDER BY id`, ...params);
			const expected = ROWS.filter((row) => matches(node, row)).map(({ id }) => id);
			expect([JSON.stringify(node), rows.map(({ id }) => id)]).toEqual([JSON.stringify(node), expected]);
		}
		await db.close();
		for (const condition of WRAPPED) {
			const { db, sql } = await table();
			const node = compileSet(T, { n: when(condition, 1, 2) }, "updateWhere");
			const statement = sql.updateWhere({ and: [] } as WhereNode, node, new Map());
			await db.run(statement.sql, ...statement.params);
			const stored = await db.all<{ [column: string]: SqliteValue }>(`SELECT * FROM t ORDER BY id`);
			const read = stored.map((row) => T.rows.decode(row, context));
			expect([JSON.stringify(node), read]).toEqual([
				JSON.stringify(node),
				ROWS.map((row) => applySet(node, row, "t")),
			]);
			await db.close();
		}
	});

	it("binds a long inArray list as one parameter (beyond SQLite's 32,766 variables)", async () => {
		const { db } = await table();
		const values = Array.from({ length: 40_000 }, (_, i) => `v${i}`);
		values.push("b");
		const node = compileWhere(T, inArray(refs.path, values), "where");
		const params: SqliteValue[] = [];
		const text = whereSql(node, params);
		expect(params).toHaveLength(1);
		const rows = await db.all<{ id: string }>(`SELECT id FROM t WHERE ${text}`, ...params);
		expect(rows.map(({ id }) => id)).toEqual(["4"]);
		await db.close();
	});

	it("updates rows as the evaluator does", async () => {
		const SETS = [
			{ n: add(refs.n, 10), count: sub(coalesce(refs.count, 5), 1) },
			{ path: replacePrefix(refs.path, "a/", "\u{1F600}/"), note: concat(refs.path, "!") },
			{ x: min(refs.x, 1), n: max(refs.n, 1), note: when(prefix(refs.path, "a"), refs.path, refs.note) },
			{ note: refs.path, path: coalesce(refs.note, "none"), count: undefined },
		];
		for (const set of SETS) {
			const { db, sql } = await table();
			const node = compileSet(T, set, "updateWhere");
			const statement = sql.updateWhere({ and: [] } as WhereNode, node, new Map());
			await db.run(statement.sql, ...statement.params);
			const stored = await db.all<{ [column: string]: SqliteValue }>(`SELECT * FROM t ORDER BY id`);
			const read = stored.map((row) => T.rows.decode(row, context));
			expect(read).toEqual(ROWS.map((row) => applySet(node, row, "t")));
			await db.close();
		}
	});
});
