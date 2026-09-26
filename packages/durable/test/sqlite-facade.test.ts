import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { StorageRejected } from "../src/errors.ts";
import { idFromNumber } from "../src/ids.ts";
import type { SqliteDatabase, SqliteStatement } from "../src/storage/sqlite/index.ts";
import { SqliteStorage } from "../src/storage/sqlite/index.ts";
import { type NodeSqliteDatabase, openNodeSqliteDatabase } from "../src/storage/sqlite/node.ts";
import { type EntryId, ROOT_CONVERSATION_ID } from "../src/types.ts";

type SettlementMode = "immediate" | "delay" | "reject";

class ControlledSettlementDatabase implements SqliteDatabase {
	private readonly delegate: NodeSqliteDatabase;
	private mode: SettlementMode = "immediate";
	private pendingSettlement: (() => void) | undefined;
	private readonly prepareCounts = new Map<string, number>();

	constructor(delegate: NodeSqliteDatabase) {
		this.delegate = delegate;
	}

	exec(sql: string): void {
		this.delegate.exec(sql);
	}

	prepare(sql: string): SqliteStatement {
		this.prepareCounts.set(sql, (this.prepareCounts.get(sql) ?? 0) + 1);
		return this.delegate.prepare(sql);
	}

	transaction<T>(callback: () => T): T | Promise<T> {
		const mode = this.mode;
		this.mode = "immediate";
		if (mode === "immediate") return this.delegate.transaction(callback);
		try {
			const result = this.delegate.transaction(() => {
				const value = callback();
				if (mode === "reject") throw new Error("controlled settlement rejection");
				return value;
			});
			return new Promise<T>((resolve) => {
				this.pendingSettlement = () => resolve(result);
			});
		} catch (error) {
			return new Promise<T>((_resolve, reject) => {
				this.pendingSettlement = () => reject(error);
			});
		}
	}

	close(): void {
		this.delegate.close();
	}

	prepareCount(sql: string): number {
		return this.prepareCounts.get(sql) ?? 0;
	}

	controlNextSettlement(mode: Exclude<SettlementMode, "immediate">): void {
		if (this.pendingSettlement !== undefined) throw new Error("A settlement is already pending");
		this.mode = mode;
	}

	settle(): void {
		const settle = this.pendingSettlement;
		if (settle === undefined) throw new Error("No settlement is pending");
		this.pendingSettlement = undefined;
		settle();
	}
}

describe("portable SQLite facade settlement", () => {
	it("prepares each storage statement once and rebinds it across commits", async () => {
		const database = new ControlledSettlementDatabase(await openNodeSqliteDatabase(":memory:"));
		const storage = await SqliteStorage.open(database);
		await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
		await storage.commit(
			Array.from({ length: 100 }, (_, index) => ({
				type: "entry" as const,
				value: { id: idFromNumber<EntryId>(index + 2), conversationId: ROOT_CONVERSATION_ID, kind: "cached" },
			})),
			BACKGROUND_CONTEXT,
		);
		await storage.commit(
			[
				{
					type: "entry",
					value: { id: idFromNumber<EntryId>(102), conversationId: ROOT_CONVERSATION_ID, kind: "cached-again" },
				},
			],
			BACKGROUND_CONTEXT,
		);
		expect((await storage.entry(idFromNumber<EntryId>(2), BACKGROUND_CONTEXT))?.entry.kind).toBe("cached");
		expect((await storage.entry(idFromNumber<EntryId>(102), BACKGROUND_CONTEXT))?.entry.kind).toBe("cached-again");
		await expect(
			storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT),
		).rejects.toThrow("ID 1 already belongs to conversation");
		expect((await storage.entry(idFromNumber<EntryId>(2), BACKGROUND_CONTEXT))?.entry.kind).toBe("cached");
		expect(database.prepareCount("SELECT record, commit_seq FROM entries WHERE id = ?")).toBe(1);
		expect(database.prepareCount("INSERT OR IGNORE INTO record_ids (id, record_type) VALUES (?, ?)")).toBe(1);
		expect(
			database.prepareCount(
				"INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)",
			),
		).toBe(1);
		await storage.close(BACKGROUND_CONTEXT);
	});

	it("rejects asynchronous Node transaction callbacks and closes idempotently", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		expect(() => database.transaction(() => Promise.resolve())).toThrow(
			"SQLite transaction callbacks must be synchronous",
		);
		database.close();
		database.close();
	});

	it("does not preserve a guaranteed rejection when rollback itself fails", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		database.exec("CREATE TABLE rollback_probe (value INTEGER)");
		expect(() =>
			database.transaction(() => {
				database.exec("INSERT INTO rollback_probe (value) VALUES (1)");
				database.exec("COMMIT");
				throw new StorageRejected("rejected after an escaped commit");
			}),
		).toThrow(AggregateError);
		expect(database.prepare("SELECT value FROM rollback_probe").get()).toEqual({ value: 1 });
		database.close();
	});

	it("awaits async transaction settlement and adopts IDs only after success", async () => {
		const database = new ControlledSettlementDatabase(await openNodeSqliteDatabase(":memory:"));
		database.controlNextSettlement("delay");
		const opening = SqliteStorage.open(database);
		let opened = false;
		void opening.then(() => {
			opened = true;
		});
		await Promise.resolve();
		expect(opened).toBe(false);
		database.settle();
		const storage = await opening;

		database.controlNextSettlement("delay");
		const committing = storage.commit(
			[
				{
					type: "entry",
					value: { id: idFromNumber<EntryId>(100), conversationId: ROOT_CONVERSATION_ID, kind: "settled" },
				},
			],
			BACKGROUND_CONTEXT,
		);
		let committed = false;
		void committing.then(() => {
			committed = true;
		});
		await Promise.resolve();
		expect(committed).toBe(false);
		expect(await storage.mintId<EntryId>()).toBe(2);
		database.settle();
		await expect(committing).resolves.toBe(1);
		expect(await storage.mintId<EntryId>()).toBe(101);

		database.controlNextSettlement("reject");
		const rejected = storage.commit(
			[
				{
					type: "entry",
					value: { id: idFromNumber<EntryId>(200), conversationId: ROOT_CONVERSATION_ID, kind: "rejected" },
				},
			],
			BACKGROUND_CONTEXT,
		);
		expect(await storage.mintId<EntryId>()).toBe(102);
		database.settle();
		await expect(rejected).rejects.toThrow("controlled settlement rejection");
		expect(await storage.mintId<EntryId>()).toBe(103);
		expect(await storage.entry(idFromNumber<EntryId>(200), BACKGROUND_CONTEXT)).toBeUndefined();
		await storage.close(BACKGROUND_CONTEXT);
	});
});
