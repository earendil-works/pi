import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, joinSqlFragments, sql } from "../src/index.ts";

describe("sql", () => {
	it("composes SQLite queries without renumbering parameters", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			sql`CREATE TABLE entries (id TEXT PRIMARY KEY, kind TEXT NOT NULL, active INTEGER NOT NULL)`.exec(db);
			sql`INSERT INTO entries (id, kind, active) VALUES (${"one"}, ${"message"}, ${1})`.run(db);
			sql`INSERT INTO entries (id, kind, active) VALUES (${"two"}, ${"message"}, ${0})`.run(db);
			const filters = joinSqlFragments([sql`kind = ${"message"}`, sql`active = ${1}`], " AND ");

			expect(sql`SELECT id FROM entries WHERE ${filters} LIMIT ${10}`.all<{ id: string }>(db)).toEqual([
				{ id: "one" },
			]);
		} finally {
			db.close();
		}
	});

	it("executes parameterized queries", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			sql`CREATE TABLE values_table (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`.exec(db);
			sql`INSERT INTO values_table (id, value) VALUES (${1}, ${"one"})`.run(db);
			sql`INSERT INTO values_table (id, value) VALUES (${2}, ${"two"})`.run(db);

			expect(sql`SELECT value FROM values_table WHERE id = ${1}`.get<{ value: string }>(db)).toEqual({
				value: "one",
			});
			expect(sql`SELECT value FROM values_table ORDER BY id`.all<{ value: string }>(db)).toEqual([
				{ value: "one" },
				{ value: "two" },
			]);
		} finally {
			db.close();
		}
	});
});
