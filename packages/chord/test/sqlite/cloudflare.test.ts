import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DurableObjectSqliteDatabase } from "../../src/sqlite/cloudflare.ts";
import { durableObjectStorage, RUN_CHANGES, runChanges } from "./helpers.ts";

describe("Durable Object SQLite driver", () => {
	it("binds and returns BLOB values as Uint8Array", async () => {
		const database = new DurableObjectSqliteDatabase(durableObjectStorage());
		await database.exec("CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB, n INTEGER)");
		await database.run("INSERT INTO blobs (id, data, n) VALUES (?, ?, ?)", 1, new Uint8Array([1, 2, 3]), 7n);
		expect(await database.get("SELECT data, n FROM blobs WHERE id = ?", 1)).toEqual({
			data: new Uint8Array([1, 2, 3]),
			n: 7,
		});
	});

	it("reports the rows a statement changed, without index writes", async () => {
		const database = new DurableObjectSqliteDatabase(durableObjectStorage());
		expect(await runChanges(database)).toEqual(RUN_CHANGES);
		const inTransaction = await database.transaction((handle) =>
			handle.runCounted("INSERT INTO changes_probe VALUES (?, ?, ?)", "t", "t/1", 1),
		);
		expect(inTransaction).toBe(1);
	});

	it("reads only the cursor's first row for get", async () => {
		const operations: string[] = [];
		const database = new DurableObjectSqliteDatabase(
			durableObjectStorage(new DatabaseSync(":memory:"), (operation) => operations.push(operation)),
		);
		await database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
		await database.run("INSERT INTO items (id) VALUES (1), (2)");
		expect(await database.get("SELECT id FROM items ORDER BY id")).toEqual({ id: 1 });
		expect(operations).toEqual(["next"]);
	});

	it("rejects a bigint binding outside the safe integer range", async () => {
		const database = new DurableObjectSqliteDatabase(durableObjectStorage());
		await database.exec("CREATE TABLE numbers (n INTEGER)");
		await expect(database.run("INSERT INTO numbers (n) VALUES (?)", 9_007_199_254_740_993n)).rejects.toThrow(
			RangeError,
		);
		expect(await database.all("SELECT n FROM numbers")).toEqual([]);
	});

	it("closes after an active transaction settles", async () => {
		const database = new DurableObjectSqliteDatabase(durableObjectStorage());
		await database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
		const order: string[] = [];
		const { promise: gate, resolve } = Promise.withResolvers<void>();
		const transaction = database.transaction(async (handle) => {
			await handle.run("INSERT INTO items (id) VALUES (?)", 1);
			await gate;
			order.push("transaction");
		});
		const closed = database.close().then(() => order.push("close"));
		resolve();
		await Promise.all([transaction, closed]);
		expect(order).toEqual(["transaction", "close"]);
	});

	it("runs an uncontended statement before returning its promise", async () => {
		const sqlite = new DatabaseSync(":memory:");
		const database = new DurableObjectSqliteDatabase(durableObjectStorage(sqlite));
		await database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
		const written = database.run("INSERT INTO items (id) VALUES (?)", 1);
		expect(sqlite.prepare("SELECT id FROM items").all()).toEqual([{ id: 1 }]);
		await written;
	});

	it("rolls back a rejected transaction and rejects its handle afterwards", async () => {
		const database = new DurableObjectSqliteDatabase(durableObjectStorage());
		await database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
		let handle: Parameters<Parameters<DurableObjectSqliteDatabase["transaction"]>[0]>[0] | undefined;
		await expect(
			database.transaction(async (transaction) => {
				handle = transaction;
				await transaction.run("INSERT INTO items (id) VALUES (?)", 1);
				throw new Error("abort");
			}),
		).rejects.toThrow("abort");
		expect(await database.all("SELECT id FROM items")).toEqual([]);
		await expect(handle!.run("INSERT INTO items (id) VALUES (?)", 2)).rejects.toThrow("no longer active");
	});

	it("runs operations from another adapter after a transaction, outside its rollback", async () => {
		const storage = durableObjectStorage();
		const database = new DurableObjectSqliteDatabase(storage);
		const other = new DurableObjectSqliteDatabase(storage);
		await database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
		const { promise: gate, resolve } = Promise.withResolvers<void>();
		const transaction = database.transaction(async (handle) => {
			await handle.run("INSERT INTO items (id) VALUES (?)", 1);
			await gate;
			throw new Error("abort");
		});
		const outside = other.run("INSERT INTO items (id) VALUES (?)", 2);
		const read = other.all("SELECT id FROM items");
		resolve();
		await expect(transaction).rejects.toThrow("abort");
		await outside;
		expect(await read).toEqual([{ id: 2 }]);
		await database.close();
	});

	it("includes direct underlying calls in an active transaction", async () => {
		const sqlite = new DatabaseSync(":memory:");
		const storage = durableObjectStorage(sqlite);
		const database = new DurableObjectSqliteDatabase(storage);
		await database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY)");
		const { promise: opened, resolve: markOpened } = Promise.withResolvers<void>();
		const { promise: gate, resolve } = Promise.withResolvers<void>();
		const transaction = database.transaction(async (handle) => {
			await handle.run("INSERT INTO items (id) VALUES (?)", 1);
			markOpened();
			await gate;
			throw new Error("abort");
		});
		await opened;
		storage.sql.exec("INSERT INTO items (id) VALUES (?)", 2);
		resolve();
		await expect(transaction).rejects.toThrow("abort");
		expect(sqlite.prepare("SELECT id FROM items").all()).toEqual([]);
	});
});
