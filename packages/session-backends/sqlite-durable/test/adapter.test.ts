import { describe, expect, it } from "vitest";
import { wrapDurableSqlite } from "../src/index.ts";
import { createMemoryDurableSqliteStorage } from "./memory-durable-sql.ts";

describe("Durable Object sqlite adapter", () => {
	it("commits a synchronous transaction and returns its result", () => {
		const db = wrapDurableSqlite(createMemoryDurableSqliteStorage());
		db.exec("CREATE TABLE values_table (value INTEGER NOT NULL)");
		const result = db.transaction(() => {
			db.prepare("INSERT INTO values_table (value) VALUES (?)").run(42);
			return "committed";
		});
		expect(result).toBe("committed");
		expect(db.prepare("SELECT value FROM values_table").get()).toEqual({ value: 42 });
	});

	it("forwards positional statement parameters", () => {
		const db = wrapDurableSqlite(createMemoryDurableSqliteStorage());
		db.exec("CREATE TABLE values_table (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
		expect(db.prepare("INSERT INTO values_table (value) VALUES (?)").run("positional")).toEqual({
			changes: 1,
		});
		expect(db.prepare("SELECT value FROM values_table WHERE id = ?").get(1)).toEqual({ value: "positional" });
	});

	it("rejects named statement parameters", () => {
		const db = wrapDurableSqlite(createMemoryDurableSqliteStorage());
		db.exec("CREATE TABLE values_table (value TEXT NOT NULL)");
		expect(() => db.prepare("INSERT INTO values_table (value) VALUES (:value)").run({ value: "named" })).toThrow(
			/positional parameters only/,
		);
	});
});
