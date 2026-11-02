import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { SqliteExecutor } from "../../src/sqlite/index.ts";
import { NodeSqliteDatabase, openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import { RUN_CHANGES, runChanges } from "./helpers.ts";

describe("Node SQLite driver", () => {
	it("configures connection defaults and accepts explicit settings", async () => {
		for (const options of [{}, { busyTimeoutMs: 123, walAutoCheckpointPages: 0 }]) {
			const database = await openNodeSqliteDatabase(":memory:", options);
			try {
				expect(await database.get("PRAGMA busy_timeout")).toEqual({ timeout: options.busyTimeoutMs ?? 5_000 });
				expect(await database.get("PRAGMA wal_autocheckpoint")).toEqual({
					wal_autocheckpoint: options.walAutoCheckpointPages ?? 1_000,
				});
				expect(await database.get("PRAGMA synchronous")).toEqual({ synchronous: 1 });
			} finally {
				await database.close();
			}
		}
	});

	it("keeps the most recently used prepared statements and prepares evicted ones again", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
		try {
			for (let i = 0; i < 300; i++) await database.get(`SELECT ${i} AS n`);
			const prepared = prepare.mock.calls.length;
			expect(await database.get("SELECT 299 AS n")).toEqual({ n: 299 });
			expect(prepare.mock.calls.length).toBe(prepared);
			expect(await database.get("SELECT 0 AS n")).toEqual({ n: 0 });
			expect(prepare.mock.calls.length).toBe(prepared + 1);
		} finally {
			prepare.mockRestore();
			await database.close();
		}
	});

	it("reports the rows a statement changed, without index writes", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		try {
			expect(await runChanges(database)).toEqual(RUN_CHANGES);
			const inTransaction = await database.transaction((handle) =>
				handle.runCounted("INSERT INTO changes_probe VALUES (?, ?, ?)", "t", "t/1", 1),
			);
			expect(inTransaction).toBe(1);
		} finally {
			await database.close();
		}
	});

	it("commits work done through the transaction handle and closes idempotently", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.transaction(async (transaction) => {
			await transaction.exec("CREATE TABLE async_probe (value INTEGER)");
			await transaction.run("INSERT INTO async_probe (value) VALUES (?)", 1);
		});
		expect(await database.get("SELECT value FROM async_probe")).toEqual({ value: 1 });
		await database.close();
		await database.close();
	});

	it("serializes concurrent transactions", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.exec("CREATE TABLE transaction_queue (value INTEGER)");
		let markFirstStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = database.transaction(async (transaction) => {
			await transaction.exec("INSERT INTO transaction_queue (value) VALUES (1)");
			markFirstStarted();
			await firstGate;
		});
		await firstStarted;

		let secondStarted = false;
		const second = database.transaction(async (transaction) => {
			secondStarted = true;
			await transaction.exec("INSERT INTO transaction_queue (value) VALUES (2)");
		});
		await Promise.resolve();
		expect(secondStarted).toBe(false);

		releaseFirst();
		await Promise.all([first, second]);
		expect(await database.all("SELECT value FROM transaction_queue ORDER BY value")).toEqual([
			{ value: 1 },
			{ value: 2 },
		]);
		await database.close();
	});

	it("runs operations in call order whether they start immediately or wait", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.exec("CREATE TABLE call_order (value INTEGER)");
		// Operations called during a transaction must neither see its uncommitted rows nor join its rollback.
		const transaction = database.transaction(async (handle) => {
			await handle.run("INSERT INTO call_order (value) VALUES (?)", 1);
			await Promise.resolve();
			throw new Error("roll back");
		});
		const beforeWrite = database.all("SELECT value FROM call_order ORDER BY value");
		const write = database.run("INSERT INTO call_order (value) VALUES (?)", 2);
		const afterWrite = database.all("SELECT value FROM call_order ORDER BY value");
		await expect(transaction).rejects.toThrow("roll back");
		await write;
		expect(await beforeWrite).toEqual([]);
		expect(await afterWrite).toEqual([{ value: 2 }]);

		await database.close();
	});

	it("queues ordinary operations behind an active transaction", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.exec("CREATE TABLE operation_queue (value INTEGER)");
		let markTransactionStarted!: () => void;
		const transactionStarted = new Promise<void>((resolve) => {
			markTransactionStarted = resolve;
		});
		let releaseTransaction!: () => void;
		const transactionGate = new Promise<void>((resolve) => {
			releaseTransaction = resolve;
		});
		const pending = database.transaction(async (transaction) => {
			await transaction.exec("INSERT INTO operation_queue (value) VALUES (1)");
			markTransactionStarted();
			await transactionGate;
		});
		await transactionStarted;

		let writeSettled = false;
		const write = database.exec("INSERT INTO operation_queue (value) VALUES (2)").finally(() => {
			writeSettled = true;
		});
		let readSettled = false;
		const read = database.all("SELECT value FROM operation_queue ORDER BY value").finally(() => {
			readSettled = true;
		});
		await Promise.resolve();
		expect(writeSettled).toBe(false);
		expect(readSettled).toBe(false);

		releaseTransaction();
		await pending;
		await write;
		await expect(read).resolves.toEqual([{ value: 1 }, { value: 2 }]);
		await database.close();
	});

	it("queues database calls made synchronously by a transaction that started immediately", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.exec("CREATE TABLE barrier_probe (value INTEGER)");
		let outside!: Promise<void>;
		const transaction = database.transaction(async (handle) => {
			// Misuse: this call must wait for the transaction instead of joining it.
			outside = database.run("INSERT INTO barrier_probe (value) VALUES (?)", 2);
			await handle.run("INSERT INTO barrier_probe (value) VALUES (?)", 1);
			await Promise.resolve();
			throw new Error("roll back");
		});
		await expect(transaction).rejects.toThrow("roll back");
		await outside;
		expect(await database.all("SELECT value FROM barrier_probe")).toEqual([{ value: 2 }]);
		await database.close();
	});

	it("rejects a transaction handle used after its transaction settles", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.exec("CREATE TABLE stale_probe (value INTEGER)");
		let handle!: SqliteExecutor;
		await database.transaction(async (transaction) => {
			handle = transaction;
			await transaction.run("INSERT INTO stale_probe (value) VALUES (?)", 1);
		});
		const stale = "SQLite transaction handle is no longer active";
		await expect(handle.exec("INSERT INTO stale_probe (value) VALUES (2)")).rejects.toThrow(stale);
		await expect(handle.run("INSERT INTO stale_probe (value) VALUES (?)", 3)).rejects.toThrow(stale);
		expect(await database.all("SELECT value FROM stale_probe")).toEqual([{ value: 1 }]);
		await database.close();
	});

	it("does not preserve the callback error when rollback itself fails", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		await database.exec("CREATE TABLE rollback_probe (value INTEGER)");
		await expect(
			database.transaction(async (transaction) => {
				await transaction.exec("INSERT INTO rollback_probe (value) VALUES (1)");
				await transaction.exec("COMMIT");
				throw new Error("rejected after an escaped commit");
			}),
		).rejects.toThrow(AggregateError);
		expect(await database.get("SELECT value FROM rollback_probe")).toEqual({ value: 1 });
		await database.close();
	});
});

describe("the outcome of a transaction (slice 6b D4)", () => {
	/** A facade on `:memory:` whose next `statement` throws (and a `ROLLBACK` still rolls back). */
	function faulty(statement?: "BEGIN IMMEDIATE" | "COMMIT" | "ROLLBACK") {
		const database = new DatabaseSync(":memory:");
		const exec = database.exec.bind(database);
		let failing = statement;
		database.exec = (sql: string): void => {
			if (sql !== failing) {
				exec(sql);
				return;
			}
			failing = undefined;
			if (sql === "ROLLBACK") exec(sql);
			throw new Error(`${sql} failed`);
		};
		return new NodeSqliteDatabase(database);
	}

	it("rejects with the callback's own error after a rollback: the caller knows it never committed", async () => {
		const database = faulty();
		const own = new Error("refused");
		await database.exec("CREATE TABLE t (n INTEGER)");
		const outcome = database.transaction(async (handle) => {
			await handle.run("INSERT INTO t VALUES (1)");
			throw own;
		});
		await expect(outcome).rejects.toBe(own);
		expect(await database.all("SELECT n FROM t")).toEqual([]);
	});

	it.each(["BEGIN IMMEDIATE", "COMMIT"] as const)("rejects with another error when %s fails", async (statement) => {
		const database = faulty(statement);
		const outcome = database.transaction(async () => 1);
		await expect(outcome).rejects.toThrow(`${statement} failed`);
	});

	it("rejects with an AggregateError, not the callback's error, when its ROLLBACK fails", async () => {
		const database = faulty("ROLLBACK");
		const own = new Error("refused");
		const error = await database.transaction(async () => Promise.reject(own)).catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(AggregateError);
		expect(error).not.toBe(own);
	});
});
