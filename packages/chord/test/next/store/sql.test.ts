// SQL text (slice 6a §8): quoted names, the DDL of tables and indexes, and the statements of a table.

import { describe, expect, it } from "vitest";
import { bool, int, num, obj, opt, str } from "../../../src/next/contracts/index.ts";
import { json } from "../../../src/next/store/json-column.ts";
import {
	createIndexSql,
	createTableSql,
	dropIndexSql,
	quote,
	TableSql,
	tableSqlName,
} from "../../../src/next/store/sql.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import { openNodeSqliteDatabase } from "../../../src/sqlite/node.ts";

const T = defineTable("edits", {
	version: 1,
	columns: {
		id: str(),
		at: int({ default: 0 }),
		x: num(),
		b: bool(),
		note: opt(str()),
		meta: json(obj({}), { version: 2 }),
	},
	key: ["id"],
});

describe("names", () => {
	it("renders <host kind>:<object type>:<table>, quoted", () => {
		expect(tableSqlName("@pi/file-history.store", "edits")).toBe("@pi/file-history.store:edits");
		expect(quote("session:a:b")).toBe('"session:a:b"');
	});
});

describe("DDL", () => {
	it("renders a STRICT WITHOUT ROWID table with checks, defaults, hidden version columns and the key", () => {
		expect(createTableSql("s:o:edits", T.record, T.key)).toBe(
			'CREATE TABLE "s:o:edits" ("id" TEXT NOT NULL, "at" INTEGER NOT NULL DEFAULT 0 CHECK ("at" BETWEEN -9007199254740991 AND 9007199254740991), ' +
				'"x" REAL NOT NULL, "b" INTEGER NOT NULL CHECK ("b" IN (0, 1)), "note" TEXT, "meta" TEXT NOT NULL, "meta$v" INTEGER NOT NULL, ' +
				'"$v" INTEGER NOT NULL, PRIMARY KEY ("id")) STRICT, WITHOUT ROWID',
		);
		expect(createIndexSql("s:o:edits", "by_at", ["at"], ["id"])).toBe(
			'CREATE INDEX "s:o:edits:by_at" ON "s:o:edits" ("at", "id")',
		);
		expect(createIndexSql("s:o:edits", "by_id", ["id", "at"], ["id"])).toBe(
			'CREATE INDEX "s:o:edits:by_id" ON "s:o:edits" ("id", "at")',
		);
		expect(dropIndexSql("s:o:edits", "by_at")).toBe('DROP INDEX "s:o:edits:by_at"');
	});

	it("keeps int columns within ±(2^53 - 1) and bool columns within 0 and 1 (rule 10)", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		await db.run(createTableSql("t", T.record, T.key));
		const sql = new TableSql("t", T.columns, T.rows.physical, T.key);
		const params = T.rows.put({ id: "a", x: 1, b: true, meta: {} }, 1).params;
		await db.run(sql.put, ...params);
		await expect(db.run(`UPDATE t SET at = ?`, 2 ** 53)).rejects.toThrow("CHECK");
		await expect(db.run(`UPDATE t SET b = 2`)).rejects.toThrow("CHECK");
		await expect(db.run(`UPDATE t SET at = 'x'`)).rejects.toThrow();
		await db.run(`INSERT INTO t (id, x, b, meta, meta$v, "$v") VALUES ('d', 1, 0, '{}', 2, 1)`);
		expect(await db.get(`SELECT at FROM t WHERE id = 'd'`)).toEqual({ at: 0 });
		await db.close();
	});
});

describe("statements", () => {
	const sql = new TableSql("t", T.columns, T.rows.physical, T.key);

	it("renders the fixed statements once", () => {
		expect(sql.put).toBe(
			'INSERT OR REPLACE INTO "t" ("id", "at", "x", "b", "note", "meta", "meta$v", "$v") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
		);
		expect(sql.get).toBe('SELECT "id", "at", "x", "b", "note", "meta", "meta$v" FROM "t" WHERE "id" = ?');
		expect(sql.delete).toBe('DELETE FROM "t" WHERE "id" = ?');
	});

	it("stamps a json column's version with its value, NULL with a clear", () => {
		const versions = new Map([["meta", 2]]);
		expect(sql.update({ meta: { json: { a: 1 } } }, ["k"], versions)).toEqual({
			sql: 'UPDATE "t" SET "meta" = ?, "meta$v" = ? WHERE "id" = ?',
			params: ['{"a":1}', 2, "k"],
		});
		expect(sql.update({ meta: null }, ["k"], versions).params).toEqual([null, "k"]);
	});

	it("binds every value: one text per query shape, whatever the values (rule 18)", () => {
		const order = { columns: ["at", "id"], direction: "desc" as const };
		const a = sql.select({ inArray: ["id", ["a", "b"]] }, order, [1, "x"], 10);
		const b = sql.select({ inArray: ["id", Array.from({ length: 40_000 }, (_, i) => `k${i}`)] }, order, [2, "y"], 99);
		expect(a.sql).toBe(b.sql);
		expect(a.sql).toBe(
			'SELECT "id", "at", "x", "b", "note", "meta", "meta$v" FROM "t" WHERE "id" IN (SELECT value FROM json_each(?)) AND ("at", "id") < (?, ?) ORDER BY "at" DESC, "id" DESC LIMIT ?',
		);
		expect(a.params).toEqual(['["a","b"]', 1, "x", 10]);
		expect(sql.count({ prefix: ["id", "\u{10FFFF}"] })).toEqual({
			sql: 'SELECT count(*) AS count FROM "t" WHERE "id" >= ?',
			params: ["\u{10FFFF}"],
		});
		expect(sql.deleteWhere({ prefix: ["id", "a"] })).toEqual({
			sql: 'DELETE FROM "t" WHERE ("id" >= ? AND "id" < ?)',
			params: ["a", "b"],
		});
	});
});
