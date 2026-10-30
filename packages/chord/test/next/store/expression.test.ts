// Tests of the table expression language: the builders and their compilation into the data vocabulary.
import { describe, expect, it } from "vitest";
import { bool, int, nul, num, obj, opt, str } from "../../../src/next/contracts/index.ts";
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
	ne,
	not,
	or,
	prefix,
	replacePrefix,
	sub,
	when,
} from "../../../src/next/store/expression.ts";
import { json } from "../../../src/next/store/json-column.ts";
import type { ColumnRefs } from "../../../src/next/store/query.ts";
import { defineTable } from "../../../src/next/store/table.ts";

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
describe("compiling conditions", () => {
	it("compiles every operator into data", () => {
		const where = and(
			eq(refs.path, "a"),
			ne(refs.n, 1),
			lt(refs.n, 2),
			lte(refs.x, 2.5),
			gt(refs.n, 0),
			gte(refs.path, "a"),
			inArray(refs.n, [1, 2]),
			isNull(refs.note),
			prefix(refs.path, "a/"),
			or(not(eq(refs.b, true))),
		);
		expect(compileWhere(T, where, "where")).toEqual({
			and: [
				{ eq: ["path", "a"] },
				{ ne: ["n", 1] },
				{ lt: ["n", 2] },
				{ lte: ["x", 2.5] },
				{ gt: ["n", 0] },
				{ gte: ["path", "a"] },
				{ inArray: ["n", [1, 2]] },
				{ isNull: "note" },
				{ prefix: ["path", "a/"] },
				{ or: [{ not: { eq: ["b", true] } }] },
			],
		});
	});

	it("refuses undefined and null operands (rule 16), wrong types, json and unknown columns", () => {
		expect(() => compileWhere(T, eq(refs.note, undefined as never), "where")).toThrow("ask with isNull");
		expect(() => compileWhere(T, eq(refs.note, null as never), "where")).toThrow(args);
		expect(() => compileWhere(T, eq(refs.n, "1" as never), "where")).toThrow(args);
		expect(() => compileWhere(T, eq(refs.n, 1.5), "where")).toThrow(args);
		expect(() => compileWhere(T, eq(refs.meta as never, 1), "where")).toThrow("not queryable");
		expect(() => compileWhere(T, eq({ column: "nope" } as never, 1), "where")).toThrow("expected a column reference");
		expect(() => compileWhere(T, "x", "where")).toThrow("expected a condition");
		expect(() => compileWhere(T, prefix(refs.n as never, "a"), "where")).toThrow("str() column");
	});

	it("makes text operands storable", () => {
		expect(compileWhere(T, eq(refs.path, "a\uD800"), "where")).toEqual({ eq: ["path", "a\uFFFD"] });
		expect(() => compileWhere(T, prefix(refs.path, "a\0"), "where")).toThrow("NUL");
	});
});

describe("compiling sets", () => {
	it("compiles plain values and expressions into one vocabulary, a clear as null (rule 14)", () => {
		expect(compileSet(T, { path: "p", note: undefined, b: true, meta: { a: 1 } }, "update")).toEqual({
			path: "p",
			note: null,
			b: true,
			meta: { json: { a: 1 } },
		});
		const set = compileSet(
			T,
			{
				n: add(refs.n, 1),
				count: sub(coalesce(refs.count, 0), refs.n),
				x: max(refs.x, 1.5),
				path: replacePrefix(concat(refs.path, "/"), "a/", "b/"),
				note: when(gt(refs.n, 1), refs.path, refs.note),
			},
			"update",
		);
		expect(JSON.parse(JSON.stringify(set))).toEqual({
			n: { add: [{ col: "n" }, 1] },
			count: { sub: [{ coalesce: [{ col: "count" }, 0] }, { col: "n" }] },
			x: { max: [{ col: "x" }, 1.5] },
			path: { replacePrefix: [{ concat: [{ col: "path" }, "/"] }, "a/", "b/"] },
			note: { when: [{ gt: ["n", 1] }, { col: "path" }, { col: "note" }] },
		});
	});

	it("refuses an empty set, key columns (rule 13), unknown columns and clears of non-opt columns", () => {
		expect(() => compileSet(T, {}, "update")).toThrow("empty");
		expect(() => compileSet(T, { id: "x" }, "update")).toThrow("cannot change");
		expect(() => compileSet(T, { nope: 1 }, "update")).toThrow('no column "nope"');
		expect(() => compileSet(T, { path: undefined }, "update")).toThrow("cannot be cleared");
	});

	it("undefined clears an opt column; null is a json(...) cell's JSON null and refused for scalar columns", () => {
		expect(compileSet(T, { note: undefined, meta: undefined }, "update")).toEqual({ note: null, meta: null });
		const Nullable = defineTable("n", {
			version: 1,
			columns: { id: str(), data: json(nul(), { version: 1 }) },
			key: ["id"],
		});
		expect(compileSet(Nullable, { data: null }, "update")).toEqual({ data: { json: null } });
		expect(() => compileSet(T, { note: null as never }, "update")).toThrow("null is no str value");
	});

	it("refuses integer arithmetic outside int columns (rule 10), type mismatches and nullable results into non-opt columns", () => {
		expect(() => compileSet(T, { x: add(refs.n, 1) }, "update")).toThrow("add gives int");
		expect(() => compileSet(T, { path: max(refs.n, 1) as never }, "update")).toThrow("gives int or num");
		expect(() => compileSet(T, { path: refs.n as never }, "update")).toThrow('column "n" is int, not str');
		expect(() => compileSet(T, { n: add(refs.count, 1) }, "update")).toThrow("may be NULL");
		expect(() => compileSet(T, { path: refs.note }, "update")).toThrow("may be NULL");
		expect(compileSet(T, { path: coalesce(refs.note, "d") }, "update")).toEqual({
			path: { coalesce: [{ col: "note" }, "d"] },
		});
		expect(() => compileSet(T, { meta: refs.meta as never }, "update")).toThrow("plain values");
	});
});
