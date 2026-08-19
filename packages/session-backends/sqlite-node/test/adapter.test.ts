import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory } from "../src/index.ts";

describe("node:sqlite adapter", () => {
	it("commits a synchronous transaction and returns its result", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			db.exec("CREATE TABLE values_table (value INTEGER NOT NULL)");
			const result = db.transaction(() => {
				db.prepare("INSERT INTO values_table (value) VALUES (?)").run(42);
				return "committed";
			});

			expect(result).toBe("committed");
			expect(db.prepare("SELECT value FROM values_table").get()).toEqual({ value: 42 });
		} finally {
			db.close();
		}
	});

	it("forwards positional and named statement parameters", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			db.exec("CREATE TABLE values_table (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
			expect(db.prepare("INSERT INTO values_table (value) VALUES (?)").run("positional")).toEqual({
				changes: 1,
				lastInsertRowid: 1,
			});
			expect(db.prepare("INSERT INTO values_table (value) VALUES (:value)").run({ value: "named" })).toEqual({
				changes: 1,
				lastInsertRowid: 2,
			});
			expect(db.prepare("SELECT value FROM values_table WHERE id = ?").get(1)).toEqual({ value: "positional" });
			expect(db.prepare("SELECT value FROM values_table WHERE id >= :id ORDER BY id").all({ id: 2 })).toEqual([
				{ value: "named" },
			]);
		} finally {
			db.close();
		}
	});

	it("rejects asynchronous transaction callbacks", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			db.exec("CREATE TABLE values_table (value INTEGER NOT NULL)");
			const asynchronous = async () => {
				db.prepare("INSERT INTO values_table (value) VALUES (?)").run(42);
				await Promise.resolve();
			};
			expect(() => db.transaction(asynchronous)).toThrow("SQLite transaction callbacks must be synchronous");
			await Promise.resolve();
			expect(db.prepare("SELECT value FROM values_table").all()).toEqual([]);
		} finally {
			db.close();
		}
	});
});
