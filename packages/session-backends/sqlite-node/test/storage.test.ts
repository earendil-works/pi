import * as storedValues from "@earendil-works/pi-agent-core";
import * as sessionWrites from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, prepareStorageCommit } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	createNodeSqliteFactory,
	type SqliteDatabase,
	type SqliteStatement,
	SqliteStorage,
	sql,
} from "../src/index.ts";
import { applyInitialSchema } from "../src/sqlite/migrations.ts";
import { advanceNextSeq, readNextSeq } from "../src/sqlite/session/session-sequences.ts";
import { listValueReadQuery } from "../src/sqlite/session/values.ts";

const SESSION_ID = "session";

class TransactionCountingDatabase implements SqliteDatabase {
	readonly source: SqliteDatabase;
	transactionCount = 0;

	constructor(source: SqliteDatabase) {
		this.source = source;
	}

	exec(query: string): void {
		this.source.exec(query);
	}

	prepare(query: string): SqliteStatement {
		return this.source.prepare(query);
	}

	transaction<T>(callback: () => T): T {
		this.transactionCount++;
		return this.source.transaction(callback);
	}

	close(): void {
		this.source.close();
	}
}

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function withStorage<T>(run: (storage: SqliteStorage, db: SqliteDatabase) => Promise<T>): Promise<T> {
	const db = await createNodeSqliteFactory().open(":memory:");
	try {
		await applyInitialSchema(db);
		const storage = new SqliteStorage(db, { sessionId: SESSION_ID, now: () => 1_700_000_000_000 });
		return await run(storage, db);
	} finally {
		db.close();
	}
}

function explainQueryPlan(db: SqliteDatabase, query: string, ...params: unknown[]): string[] {
	return db
		.prepare(`EXPLAIN QUERY PLAN ${query}`)
		.all<{ detail: string }>(...params)
		.map((row) => row.detail);
}

function expectBranchPlan(plan: string[]): void {
	expect(plan.some((detail) => detail.includes("SEARCH b USING COVERING INDEX ix_be_seq"))).toBe(true);
	expect(plan.some((detail) => detail.includes("SEARCH e USING PRIMARY KEY"))).toBe(true);
	expect(plan.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false);
	expect(plan.some((detail) => detail.includes("SCAN e"))).toBe(false);
}

function insertCommitSessionRow(db: SqliteDatabase, nextSeq = 1): void {
	sql`INSERT INTO sessions
		(id, created_at, parent_session_id, storage_version, metadata, message_count, usage_payload, next_seq)
		VALUES (
			${SESSION_ID},
			${1},
			${null},
			${1},
			${null},
			${0},
			${JSON.stringify(ZERO_USAGE)},
			${nextSeq}
		)`.run(db);
}

describe("SqliteStorage", () => {
	it("uses one write transaction for an ordinary commit", async () => {
		const db = new TransactionCountingDatabase(await createNodeSqliteFactory().open(":memory:"));
		try {
			await applyInitialSchema(db);
			insertCommitSessionRow(db);
			const storage = new SqliteStorage(db, { sessionId: SESSION_ID, now: () => 1_700_000_000_000 });

			await storage.commit([storedValues.setValue(storedValues.sessionName, "name")], BACKGROUND_CONTEXT);

			expect(db.transactionCount).toBe(1);
			await storage.close(BACKGROUND_CONTEXT);
		} finally {
			db.close();
		}
	});

	it("commits root entries and append-to-tip entries into the branch index", async () => {
		await withStorage(async (storage, db) => {
			insertCommitSessionRow(db);

			expect(
				await storage.commit(
					[
						sessionWrites.insertEntry({
							id: "root",
							parentId: null,
							type: "message",
							message: { role: "user", content: "root", timestamp: 10 },
						}),
					],
					BACKGROUND_CONTEXT,
				),
			).toEqual({
				firstSeq: 1,
				seqs: [1],
				timestamp: 1_700_000_000_000,
				stats: { messageCount: 1, usage: ZERO_USAGE },
			});
			expect(
				await storage.commit(
					[
						sessionWrites.insertEntry({
							id: "child",
							parentId: "root",
							type: "message",
							message: { role: "user", content: "child", timestamp: 11 },
						}),
					],
					BACKGROUND_CONTEXT,
				),
			).toEqual({
				firstSeq: 2,
				seqs: [2],
				timestamp: 1_700_000_000_000,
				stats: { messageCount: 2, usage: ZERO_USAGE },
			});

			expect(sql`SELECT branch_id, tip_entry_id, tip_seq FROM branch_meta`.all(db)).toEqual([
				{ branch_id: "root", tip_entry_id: "child", tip_seq: 2 },
			]);
			expect(
				sql`SELECT branch_id, entry_id, entry_seq, entry_type FROM branch_entries ORDER BY entry_seq`.all(db),
			).toEqual([
				{ branch_id: "root", entry_id: "root", entry_seq: 1, entry_type: "message" },
				{ branch_id: "root", entry_id: "child", entry_seq: 2, entry_type: "message" },
			]);
			expect((await storage.scanBranch({ start: "child" }, BACKGROUND_CONTEXT)).map((entry) => entry.id)).toEqual([
				"child",
				"root",
			]);
		});
	});

	it("commits divergent branch entries by materializing a new segment", async () => {
		await withStorage(async (storage, db) => {
			insertCommitSessionRow(db);
			await storage.commit(
				[
					sessionWrites.insertEntry({
						id: "root",
						parentId: null,
						type: "message",
						message: { role: "user", content: "root", timestamp: 10 },
					}),
					sessionWrites.insertEntry({
						id: "left",
						parentId: "root",
						type: "message",
						message: { role: "user", content: "left", timestamp: 11 },
					}),
					sessionWrites.insertEntry({
						id: "right",
						parentId: "root",
						type: "message",
						message: { role: "user", content: "right", timestamp: 12 },
					}),
				],
				BACKGROUND_CONTEXT,
			);

			expect(
				sql`SELECT branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq FROM branch_meta ORDER BY branch_id`.all(
					db,
				),
			).toEqual([
				{ branch_id: "right", tip_entry_id: "right", tip_seq: 3, base_branch_id: null, base_seq: null },
				{ branch_id: "root", tip_entry_id: "left", tip_seq: 2, base_branch_id: null, base_seq: null },
			]);
			expect(
				sql`SELECT branch_id, entry_id, entry_seq, entry_type FROM branch_entries ORDER BY branch_id, entry_seq`.all(
					db,
				),
			).toEqual([
				{ branch_id: "right", entry_id: "root", entry_seq: 1, entry_type: "message" },
				{ branch_id: "right", entry_id: "right", entry_seq: 3, entry_type: "message" },
				{ branch_id: "root", entry_id: "root", entry_seq: 1, entry_type: "message" },
				{ branch_id: "root", entry_id: "left", entry_seq: 2, entry_type: "message" },
			]);
			expect((await storage.scanBranch({ start: "right" }, BACKGROUND_CONTEXT)).map((entry) => entry.id)).toEqual([
				"right",
				"root",
			]);
			expect((await storage.scanBranch({ start: "left" }, BACKGROUND_CONTEXT)).map((entry) => entry.id)).toEqual([
				"left",
				"root",
			]);
		});
	});

	it("bases divergent branch segments at the newest compaction", async () => {
		await withStorage(async (storage, db) => {
			insertCommitSessionRow(db);
			await storage.commit(
				[
					sessionWrites.insertEntry({
						id: "root",
						parentId: null,
						type: "message",
						message: { role: "user", content: "root", timestamp: 10 },
					}),
					sessionWrites.insertEntry({
						id: "compact",
						parentId: "root",
						type: "compaction",
						summary: "summary",
						retainedTail: [],
						tokensBefore: 1,
						fromHook: false,
					}),
					sessionWrites.insertEntry({
						id: "left",
						parentId: "compact",
						type: "message",
						message: { role: "user", content: "left", timestamp: 11 },
					}),
					sessionWrites.insertEntry({
						id: "leaf",
						parentId: "left",
						type: "message",
						message: { role: "user", content: "leaf", timestamp: 12 },
					}),
					sessionWrites.insertEntry({
						id: "right",
						parentId: "left",
						type: "message",
						message: { role: "user", content: "right", timestamp: 13 },
					}),
				],
				BACKGROUND_CONTEXT,
			);

			expect(
				sql`SELECT branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq FROM branch_meta WHERE branch_id = ${"right"}`.get(
					db,
				),
			).toEqual({
				branch_id: "right",
				tip_entry_id: "right",
				tip_seq: 5,
				base_branch_id: "root",
				base_seq: 2,
			});
			expect(
				sql`SELECT branch_id, entry_id, entry_seq, entry_type FROM branch_entries WHERE branch_id = ${"right"} ORDER BY entry_seq`.all(
					db,
				),
			).toEqual([
				{ branch_id: "right", entry_id: "left", entry_seq: 3, entry_type: "message" },
				{ branch_id: "right", entry_id: "right", entry_seq: 5, entry_type: "message" },
			]);
			expect((await storage.scanBranch({ start: "right" }, BACKGROUND_CONTEXT)).map((entry) => entry.id)).toEqual([
				"right",
				"left",
				"compact",
				"root",
			]);
		});
	});

	it("gets entries by requested id order", async () => {
		await withStorage(async (storage, db) => {
			sql`INSERT INTO entries (session_id, id, parent_id, seq, type, custom_type, timestamp, payload)
				VALUES
					(${SESSION_ID}, ${"first"}, ${null}, ${1}, ${"custom"}, ${"note"}, ${10}, ${JSON.stringify({ data: { value: 1 } })}),
					(${SESSION_ID}, ${"second"}, ${"first"}, ${2}, ${"message"}, ${null}, ${11}, ${JSON.stringify({ message: { role: "user", content: "hi", timestamp: 11 } })})`.run(
				db,
			);

			const entries = await storage.getEntries(["second", "missing", "first"], BACKGROUND_CONTEXT);

			expect([...entries.keys()]).toEqual(["second", "first"]);
			expect(entries.get("second")).toMatchObject({ id: "second", type: "message", parentId: "first" });
			expect(entries.get("first")).toMatchObject({ id: "first", type: "custom", customType: "note" });
		});
	});

	it("scans decoded entries with filters and sequence bounds", async () => {
		await withStorage(async (storage, db) => {
			sql`INSERT INTO entries (session_id, id, parent_id, seq, type, custom_type, timestamp, payload)
				VALUES
					(${SESSION_ID}, ${"one"}, ${null}, ${1}, ${"custom"}, ${"note"}, ${10}, ${JSON.stringify({ data: 1 })}),
					(${SESSION_ID}, ${"two"}, ${"one"}, ${2}, ${"message"}, ${null}, ${11}, ${JSON.stringify({ message: { role: "user", content: "two", timestamp: 11 } })}),
					(${SESSION_ID}, ${"three"}, ${"two"}, ${3}, ${"custom"}, ${"note"}, ${12}, ${JSON.stringify({ data: 3 })})`.run(
				db,
			);

			expect(
				(await storage.scanEntries({ order: "desc", type: "custom", fromSeq: 2 }, BACKGROUND_CONTEXT)).map(
					(entry) => entry.id,
				),
			).toEqual(["three"]);
			expect(
				(await storage.scanEntries({ order: "asc", customType: "note", limit: 2 }, BACKGROUND_CONTEXT)).map(
					(entry) => entry.id,
				),
			).toEqual(["one", "three"]);
		});
	});

	it("scans branch entries through materialized branch segments", async () => {
		await withStorage(async (storage, db) => {
			sql`INSERT INTO entries (session_id, id, parent_id, seq, type, custom_type, timestamp, payload)
				VALUES
					(${SESSION_ID}, ${"root"}, ${null}, ${1}, ${"message"}, ${null}, ${10}, ${JSON.stringify({ message: { role: "user", content: "root", timestamp: 10 } })}),
					(${SESSION_ID}, ${"compact"}, ${"root"}, ${2}, ${"compaction"}, ${null}, ${11}, ${JSON.stringify({ summary: "s", retainedTail: [], tokensBefore: 1, fromHook: false })}),
					(${SESSION_ID}, ${"old"}, ${"compact"}, ${3}, ${"message"}, ${null}, ${12}, ${JSON.stringify({ message: { role: "assistant", content: "old", timestamp: 12 } })}),
					(${SESSION_ID}, ${"custom"}, ${"old"}, ${4}, ${"custom"}, ${"note"}, ${13}, ${JSON.stringify({ data: 4 })}),
					(${SESSION_ID}, ${"leaf"}, ${"custom"}, ${5}, ${"message"}, ${null}, ${14}, ${JSON.stringify({ message: { role: "user", content: "leaf", timestamp: 14 } })})`.run(
				db,
			);
			sql`INSERT INTO branch_meta (session_id, branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq)
				VALUES
					(${SESSION_ID}, ${"base"}, ${"compact"}, ${2}, ${null}, ${null}),
					(${SESSION_ID}, ${"new"}, ${"leaf"}, ${5}, ${"base"}, ${2})`.run(db);
			sql`INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq, entry_type)
				VALUES
					(${SESSION_ID}, ${"base"}, ${"root"}, ${1}, ${"message"}),
					(${SESSION_ID}, ${"base"}, ${"compact"}, ${2}, ${"compaction"}),
					(${SESSION_ID}, ${"new"}, ${"old"}, ${3}, ${"message"}),
					(${SESSION_ID}, ${"new"}, ${"custom"}, ${4}, ${"custom"}),
					(${SESSION_ID}, ${"new"}, ${"leaf"}, ${5}, ${"message"})`.run(db);

			expect(
				(await storage.scanBranch({ start: "leaf", stopAtType: "compaction", limit: 2 }, BACKGROUND_CONTEXT)).map(
					(entry) => entry.id,
				),
			).toEqual(["leaf", "custom"]);
			expect(
				(
					await storage.scanBranch(
						{ start: "leaf", order: "oldestFirst", type: "message", cursor: { seq: 1 } },
						BACKGROUND_CONTEXT,
					)
				).map((entry) => entry.id),
			).toEqual(["old", "leaf"]);
		});
	});

	it("resolves a branch segment that physically contains the start entry", async () => {
		await withStorage(async (storage, db) => {
			sql`INSERT INTO entries (session_id, id, parent_id, seq, type, custom_type, timestamp, payload)
				VALUES
					(${SESSION_ID}, ${"root"}, ${null}, ${1}, ${"message"}, ${null}, ${10}, ${JSON.stringify({ message: { role: "user", content: "root", timestamp: 10 } })}),
					(${SESSION_ID}, ${"base-tip"}, ${"root"}, ${2}, ${"message"}, ${null}, ${11}, ${JSON.stringify({ message: { role: "assistant", content: "base", timestamp: 11 } })}),
					(${SESSION_ID}, ${"new-tip"}, ${"base-tip"}, ${3}, ${"message"}, ${null}, ${12}, ${JSON.stringify({ message: { role: "user", content: "new", timestamp: 12 } })})`.run(
				db,
			);
			sql`INSERT INTO branch_meta (session_id, branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq)
				VALUES
					(${SESSION_ID}, ${"aaa-new"}, ${"new-tip"}, ${3}, ${"zzz-base"}, ${2}),
					(${SESSION_ID}, ${"zzz-base"}, ${"base-tip"}, ${2}, ${null}, ${null})`.run(db);
			sql`INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq, entry_type)
				VALUES
					(${SESSION_ID}, ${"aaa-new"}, ${"new-tip"}, ${3}, ${"message"}),
					(${SESSION_ID}, ${"zzz-base"}, ${"root"}, ${1}, ${"message"}),
					(${SESSION_ID}, ${"zzz-base"}, ${"base-tip"}, ${2}, ${"message"})`.run(db);

			expect(
				(await storage.scanBranch({ start: "base-tip", order: "oldestFirst" }, BACKGROUND_CONTEXT)).map(
					(entry) => entry.id,
				),
			).toEqual(["root", "base-tip"]);
		});
	});

	it("applies branch stop boundaries across base segments before filtering", async () => {
		await withStorage(async (storage, db) => {
			sql`INSERT INTO entries (session_id, id, parent_id, seq, type, custom_type, timestamp, payload)
				VALUES
					(${SESSION_ID}, ${"root"}, ${null}, ${1}, ${"message"}, ${null}, ${10}, ${JSON.stringify({ message: { role: "user", content: "root", timestamp: 10 } })}),
					(${SESSION_ID}, ${"compact"}, ${"root"}, ${2}, ${"compaction"}, ${null}, ${11}, ${JSON.stringify({ summary: "s", retainedTail: [], tokensBefore: 1, fromHook: false })}),
					(${SESSION_ID}, ${"after"}, ${"compact"}, ${3}, ${"message"}, ${null}, ${12}, ${JSON.stringify({ message: { role: "assistant", content: "after", timestamp: 12 } })}),
					(${SESSION_ID}, ${"leaf"}, ${"after"}, ${4}, ${"custom"}, ${"note"}, ${13}, ${JSON.stringify({ data: 4 })})`.run(
				db,
			);
			sql`INSERT INTO branch_meta (session_id, branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq)
				VALUES
					(${SESSION_ID}, ${"base"}, ${"compact"}, ${2}, ${null}, ${null}),
					(${SESSION_ID}, ${"new"}, ${"leaf"}, ${4}, ${"base"}, ${2})`.run(db);
			sql`INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq, entry_type)
				VALUES
					(${SESSION_ID}, ${"base"}, ${"root"}, ${1}, ${"message"}),
					(${SESSION_ID}, ${"base"}, ${"compact"}, ${2}, ${"compaction"}),
					(${SESSION_ID}, ${"new"}, ${"after"}, ${3}, ${"message"}),
					(${SESSION_ID}, ${"new"}, ${"leaf"}, ${4}, ${"custom"})`.run(db);

			expect(
				(await storage.scanBranch({ start: "leaf", stopAtType: "compaction" }, BACKGROUND_CONTEXT)).map(
					(entry) => entry.id,
				),
			).toEqual(["leaf", "after", "compact"]);
			expect(
				(
					await storage.scanBranch(
						{ start: "leaf", stopAtType: "compaction", type: "message" },
						BACKGROUND_CONTEXT,
					)
				).map((entry) => entry.id),
			).toEqual(["after"]);
		});
	});

	it("uses branch_entries as the outer scan for branch payload queries", async () => {
		await withStorage(async (_storage, db) => {
			const plan = explainQueryPlan(
				db,
				`SELECT e.id, e.parent_id, e.seq, e.type, e.custom_type, e.timestamp, e.payload
				FROM branch_entries b
				CROSS JOIN entries e ON e.session_id = b.session_id AND e.id = b.entry_id
				WHERE b.session_id = ? AND b.branch_id = ? AND b.entry_seq > ? AND b.entry_seq <= ?
				ORDER BY b.entry_seq DESC LIMIT ?`,
				SESSION_ID,
				"main",
				0,
				10,
				2,
			);

			expectBranchPlan(plan);
		});
	});

	it("scans branch structure without payloads", async () => {
		await withStorage(async (storage, db) => {
			sql`INSERT INTO entries (session_id, id, parent_id, seq, type, custom_type, timestamp, payload)
				VALUES
					(${SESSION_ID}, ${"root"}, ${null}, ${1}, ${"message"}, ${null}, ${10}, ${JSON.stringify({ message: { role: "user", content: "root", timestamp: 10 } })}),
					(${SESSION_ID}, ${"custom"}, ${"root"}, ${2}, ${"custom"}, ${"note"}, ${11}, ${JSON.stringify({ data: 2 })})`.run(
				db,
			);
			sql`INSERT INTO branch_meta (session_id, branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq)
				VALUES (${SESSION_ID}, ${"main"}, ${"custom"}, ${2}, ${null}, ${null})`.run(db);
			sql`INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq, entry_type)
				VALUES
					(${SESSION_ID}, ${"main"}, ${"root"}, ${1}, ${"message"}),
					(${SESSION_ID}, ${"main"}, ${"custom"}, ${2}, ${"custom"})`.run(db);

			expect(await storage.scanBranchStructure({ start: "custom", customType: "note" }, BACKGROUND_CONTEXT)).toEqual(
				[
					{
						id: "custom",
						parentId: "root",
						seq: 2,
						timestamp: 11,
						type: "custom",
						customType: "note",
					},
				],
			);
		});
	});

	it("uses branch_entries as the outer scan for branch structure queries", async () => {
		await withStorage(async (_storage, db) => {
			const plan = explainQueryPlan(
				db,
				`SELECT e.id, e.parent_id, e.seq, e.type, e.custom_type, e.timestamp
				FROM branch_entries b
				CROSS JOIN entries e ON e.session_id = b.session_id AND e.id = b.entry_id
				WHERE b.session_id = ? AND b.branch_id = ? AND b.entry_seq > ? AND b.entry_seq <= ?
				ORDER BY b.entry_seq ASC LIMIT ?`,
				SESSION_ID,
				"main",
				0,
				10,
				2,
			);

			expectBranchPlan(plan);
		});
	});

	it("scans decoded usage rows with sequence bounds", async () => {
		await withStorage(async (storage, db) => {
			const usage = {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				totalTokens: 10,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
			};
			sql`INSERT INTO usage_ledger (session_id, id, seq, entry_id, adjustment, usage, details)
				VALUES
					(${SESSION_ID}, ${"u1"}, ${1}, ${"e1"}, ${0}, ${JSON.stringify(usage)}, ${null}),
					(${SESSION_ID}, ${"u2"}, ${2}, ${null}, ${1}, ${JSON.stringify(usage)}, ${JSON.stringify({ reason: "adjust" })}),
					(${SESSION_ID}, ${"u3"}, ${3}, ${"e3"}, ${0}, ${JSON.stringify(usage)}, ${null})`.run(db);

			expect(await storage.scanUsage({ fromSeq: 2, order: "asc", limit: 1 }, BACKGROUND_CONTEXT)).toEqual([
				{ id: "u2", seq: 2, usage, adjustment: true, details: { reason: "adjust" } },
			]);
			expect(
				(await storage.scanUsage({ toSeq: 2, order: "desc" }, BACKGROUND_CONTEXT)).map((row) => row.id),
			).toEqual(["u2", "u1"]);
		});
	});

	it("prepares committed writes with assigned sequences and timestamp", () => {
		const prepared = prepareStorageCommit(
			[
				sessionWrites.insertEntry({
					id: "entry",
					parentId: null,
					type: "message",
					message: { role: "user", content: "hi", timestamp: 1 },
				}),
				sessionWrites.insertUsage({
					id: "usage",
					usage: {
						input: 1,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 3,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					adjustment: false,
				}),
				storedValues.setValue(storedValues.sessionName, "name"),
				storedValues.deleteValue(storedValues.entryLabel("entry")),
			],
			7,
			1_700_000_000_000,
		);

		expect(prepared.result).toEqual({ firstSeq: 7, seqs: [7, 8, 9, 10], timestamp: 1_700_000_000_000 });
		expect(prepared.writes).toMatchObject([
			{ kind: "entry", id: "entry", seq: 7, timestamp: 1_700_000_000_000 },
			{ kind: "usage", id: "usage", seq: 8 },
			storedValues.setValue(storedValues.sessionName, "name"),
			storedValues.deleteValue(storedValues.entryLabel("entry")),
		]);
	});

	it("reads and advances the next commit sequence", async () => {
		await withStorage(async (_storage, db) => {
			sql`INSERT INTO sessions
				(id, created_at, parent_session_id, storage_version, metadata, message_count, usage_payload, next_seq)
				VALUES (${SESSION_ID}, ${1}, ${null}, ${1}, ${null}, ${0}, ${JSON.stringify({})}, ${7})`.run(db);

			expect(readNextSeq(db, SESSION_ID)).toBe(7);
			advanceNextSeq(db, SESSION_ID, 10);
			expect(readNextSeq(db, SESSION_ID)).toBe(10);
		});
	});

	it("gets maintained session stats", async () => {
		await withStorage(async (storage, db) => {
			const usage = {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				totalTokens: 10,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
			};
			sql`INSERT INTO sessions
				(id, created_at, parent_session_id, storage_version, metadata, message_count, usage_payload, next_seq)
				VALUES (${SESSION_ID}, ${1}, ${null}, ${1}, ${null}, ${2}, ${JSON.stringify(usage)}, ${3})`.run(db);

			expect(await storage.getStats(BACKGROUND_CONTEXT)).toEqual({ messageCount: 2, usage });
			const next = await storage.commit(
				[storedValues.setValue(storedValues.sessionName, "after-history")],
				BACKGROUND_CONTEXT,
			);
			expect(next.stats).toEqual({ messageCount: 2, usage });
		});
	});

	it("includes historical totals in the first commit after storage reopen", async () => {
		await withStorage(async (storage, db) => {
			insertCommitSessionRow(db);
			const usage = {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			await storage.commit(
				[
					sessionWrites.insertEntry({
						id: "history",
						parentId: null,
						type: "message",
						message: { role: "user", content: "history", timestamp: 1 },
					}),
					sessionWrites.insertUsage({ id: "usage", usage, adjustment: false }),
				],
				BACKGROUND_CONTEXT,
			);
			await storage.close(BACKGROUND_CONTEXT);

			const reopened = new SqliteStorage(db, { sessionId: SESSION_ID, now: () => 1_700_000_000_000 });
			const result = await reopened.commit(
				[storedValues.setValue(storedValues.sessionName, "reopened")],
				BACKGROUND_CONTEXT,
			);
			expect(result.stats).toEqual({ messageCount: 1, usage });
			expect(result.stats).toEqual(await reopened.getStats(BACKGROUND_CONTEXT));
			await reopened.close(BACKGROUND_CONTEXT);
		});
	});

	it("gets a decoded scalar value by bound address", async () => {
		await withStorage(async (storage, db) => {
			const address = storedValues.value<{ ready: boolean }>("test.value", "state");
			sql`INSERT INTO scalar_values (session_id, namespace, key, seq, value)
				VALUES (${SESSION_ID}, ${address.namespace}, ${address.key}, ${1}, ${JSON.stringify({ ready: true })})`.run(
				db,
			);

			expect(await storage.getValue(address, BACKGROUND_CONTEXT)).toEqual({
				address,
				seq: 1,
				value: { ready: true },
			});
			expect(
				await storage.getValue(storedValues.value<unknown>("test.value", "missing"), BACKGROUND_CONTEXT),
			).toBeUndefined();
		});
	});

	it("scans decoded scalar values by namespace and key prefix", async () => {
		await withStorage(async (storage, db) => {
			sql`INSERT INTO scalar_values (session_id, namespace, key, seq, value)
				VALUES
					(${SESSION_ID}, ${"test.value"}, ${"app:one"}, ${1}, ${JSON.stringify(1)}),
					(${SESSION_ID}, ${"test.value"}, ${"app:two"}, ${2}, ${JSON.stringify(2)}),
					(${SESSION_ID}, ${"test.value"}, ${"app:\ufffftail"}, ${3}, ${JSON.stringify(3)}),
					(${SESSION_ID}, ${"test.value"}, ${"app;other"}, ${4}, ${JSON.stringify(4)}),
					(${SESSION_ID}, ${"test.value"}, ${"other"}, ${5}, ${JSON.stringify(5)}),
					(${SESSION_ID}, ${"other.value"}, ${""}, ${6}, ${JSON.stringify("name")})`.run(db);

			expect(
				await storage.scanValues(storedValues.value<unknown>("test.value", "app:"), BACKGROUND_CONTEXT),
			).toEqual([
				{ address: storedValues.value<unknown>("test.value", "app:one"), seq: 1, value: 1 },
				{ address: storedValues.value<unknown>("test.value", "app:two"), seq: 2, value: 2 },
				{ address: storedValues.value<unknown>("test.value", "app:\ufffftail"), seq: 3, value: 3 },
			]);
		});
	});

	it("uses the list primary key for ascending and descending cursor pages", async () => {
		await withStorage(async (_storage, db) => {
			const address = storedValues.list<unknown>("test.list", "events");
			for (const options of [
				{ order: "asc" as const },
				{ order: "asc" as const, cursor: { seq: 4 } },
				{ order: "desc" as const },
				{ order: "desc" as const, cursor: { seq: 4 } },
			]) {
				const query = listValueReadQuery(SESSION_ID, address, options);
				const plan = explainQueryPlan(db, query.queryText, ...query.params);
				expect(plan.some((detail) => detail.includes("USING PRIMARY KEY"))).toBe(true);
				expect(plan.some((detail) => detail.includes("SCAN list_values"))).toBe(false);
				expect(plan.some((detail) => detail.includes("USE TEMP B-TREE"))).toBe(false);
			}
		});
	});
});
