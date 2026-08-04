import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory } from "../../../storage/sqlite-node/src/index.ts";

describe("node:sqlite adapter", () => {
	it("runs transaction callbacks synchronously", async () => {
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
