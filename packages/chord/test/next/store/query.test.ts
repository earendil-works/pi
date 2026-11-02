// Queries (slice 6a §7): `where`, `orderBy` and limits over a table, and cursors paging through them.

import { describe, expect, it } from "vitest";
import { int, opt, str } from "../../../src/next/contracts/index.ts";
import { eq, gt } from "../../../src/next/store/expression.ts";
import { decodeCursor, encodeCursor, query } from "../../../src/next/store/query.ts";
import { defineTable } from "../../../src/next/store/table.ts";

const T = defineTable("edits", {
	version: 1,
	columns: { id: str(), entry: int(), at: int(), note: opt(str()) },
	key: ["id", "entry"],
});
const args = expect.objectContaining({ code: "invalid", reason: "args" });

describe("queries", () => {
	it("are immutable; several wheres are and-ed", () => {
		const base = query(T);
		const one = base.where((e) => eq(e.id, "a"));
		const two = one.where((e) => gt(e.at, 1));
		expect(base.condition).toBeUndefined();
		expect(one.condition).toEqual({ eq: ["id", "a"] });
		expect(two.condition).toEqual({ and: [{ eq: ["id", "a"] }, { gt: ["at", 1] }] });
	});

	it("order by the key ascending by default and append the key as the tie-break, not repeated", () => {
		expect(query(T).order).toEqual({ columns: ["id", "entry"], direction: "asc" });
		expect(query(T).orderBy((e) => e.at, "desc").order).toEqual({
			columns: ["at", "id", "entry"],
			direction: "desc",
		});
		expect(query(T).orderBy((e) => e.entry).order).toEqual({ columns: ["entry", "id"], direction: "asc" });
	});

	it("refuse duplicate orderBy columns, two directions and opt columns (rule 17)", () => {
		expect(() =>
			query(T)
				.orderBy((e) => e.at)
				.orderBy((e) => e.at),
		).toThrow("twice");
		expect(() =>
			query(T)
				.orderBy((e) => e.at)
				.orderBy((e) => e.id, "desc"),
		).toThrow("one direction");
		expect(() => query(T).orderBy((e) => e.note as never)).toThrow(args);
	});
});

describe("cursors", () => {
	const order = query(T).orderBy((e) => e.at, "desc").order;

	it("round-trip the order values, also across conditions with the same order", () => {
		const cursor = encodeCursor("app:edits", order, [5, "a\u{1F600}", 2]);
		expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(decodeCursor(T, "app:edits", order, cursor)).toEqual([5, "a\u{1F600}", 2]);
		const other = query(T)
			.where((e) => eq(e.id, "x"))
			.orderBy((e) => e.at, "desc").order;
		expect(decodeCursor(T, "app:edits", other, cursor)).toEqual([5, "a\u{1F600}", 2]);
	});

	it("are a trust boundary: another table, order or direction, garbage and bad values are invalid/args", () => {
		const cursor = encodeCursor("app:edits", order, [5, "a", 2]);
		expect(() => decodeCursor(T, "app:edits", query(T).order, cursor)).toThrow(args);
		expect(() => decodeCursor(T, "app:edits", query(T).orderBy((e) => e.at).order, cursor)).toThrow(args);
		expect(() =>
			decodeCursor(
				defineTable("other", { version: 1, columns: { id: str(), entry: int(), at: int() }, key: ["id", "entry"] }),
				"app:other",
				order,
				cursor,
			),
		).toThrow(args);
		// The same definition in another object's table.
		expect(() => decodeCursor(T, "other:edits", order, cursor)).toThrow(args);
		expect(() => decodeCursor(T, "app:edits", order, "%%%")).toThrow(args);
		expect(() => decodeCursor(T, "app:edits", order, 42)).toThrow(args);
		expect(() => decodeCursor(T, "app:edits", order, encodeCursor("app:edits", order, ["x", "a", 2]))).toThrow(args);
		expect(() => decodeCursor(T, "app:edits", order, encodeCursor("app:edits", order, [5, "a"]))).toThrow(args);
	});
});
