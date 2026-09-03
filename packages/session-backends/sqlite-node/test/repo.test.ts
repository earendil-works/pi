import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import * as storedValues from "@earendil-works/pi-agent-core";
import * as sessionWrites from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { SqliteDatabase, SqliteDatabaseFactory, SqliteStatement } from "../src/index.ts";
import { createNodeSqliteFactory, SqliteSessionRepo, sql } from "../src/index.ts";

const TEST_LANE_CONFIGURATION = {
	model: { provider: "test", modelId: "test" },
	thinkingLevel: "off",
	activeToolNames: [],
} satisfies storedValues.LaneConfiguration;
const IDLE_LANE_STATE = {
	currentOperationId: null,
	lastOperationId: null,
	inbox: [],
} satisfies storedValues.LaneState;

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-session-"));
	try {
		return await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function withDb<T>(path: string, run: (db: SqliteDatabase) => Promise<T> | T): Promise<T> {
	const db = await createNodeSqliteFactory().open(path);
	try {
		return await run(db);
	} finally {
		db.close();
	}
}

async function pathExists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

class ForwardingDatabase implements SqliteDatabase {
	readonly source: SqliteDatabase;

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
		return this.source.transaction(callback);
	}

	close(): void {
		this.source.close();
	}
}

class SnapshotBoundaryStatement implements SqliteStatement {
	readonly source: SqliteStatement;
	readonly afterGet: () => void;
	private called = false;

	constructor(source: SqliteStatement, afterGet: () => void) {
		this.source = source;
		this.afterGet = afterGet;
	}

	run(...params: unknown[]) {
		return this.source.run(...params);
	}

	get<TRow extends object>(...params: unknown[]): TRow | undefined {
		const row = this.source.get<TRow>(...params);
		if (!this.called) {
			this.called = true;
			this.afterGet();
		}
		return row;
	}

	all<TRow extends object>(...params: unknown[]): TRow[] {
		return this.source.all<TRow>(...params);
	}

	iterate<TRow extends object>(...params: unknown[]): Iterable<TRow> {
		return this.source.iterate<TRow>(...params);
	}
}

class SnapshotBoundaryDatabase extends ForwardingDatabase {
	readonly afterSnapshotEstablished: () => void;

	constructor(source: SqliteDatabase, afterSnapshotEstablished: () => void) {
		super(source);
		this.afterSnapshotEstablished = afterSnapshotEstablished;
	}

	override prepare(query: string): SqliteStatement {
		const statement = this.source.prepare(query);
		return query.includes("FROM sessions")
			? new SnapshotBoundaryStatement(statement, this.afterSnapshotEstablished)
			: statement;
	}
}

class SnapshotBoundaryFactory implements SqliteDatabaseFactory {
	readonly source = createNodeSqliteFactory();
	readonly afterSnapshotEstablished: () => void;
	readOnlyOpenCount = 0;

	constructor(afterSnapshotEstablished: () => void) {
		this.afterSnapshotEstablished = afterSnapshotEstablished;
	}

	open(path: string): Promise<SqliteDatabase> {
		return this.source.open(path);
	}

	openExisting(path: string): Promise<SqliteDatabase> {
		return this.source.openExisting(path);
	}

	async openReadOnly(path: string): Promise<SqliteDatabase> {
		this.readOnlyOpenCount++;
		return new SnapshotBoundaryDatabase(await this.source.openReadOnly(path), this.afterSnapshotEstablished);
	}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

class GatedOpenExistingFactory implements SqliteDatabaseFactory {
	readonly source = createNodeSqliteFactory();
	readonly entered = deferred();
	readonly release = deferred();
	private gated = false;

	arm(): void {
		this.gated = true;
	}

	open(path: string): Promise<SqliteDatabase> {
		return this.source.open(path);
	}

	async openExisting(path: string): Promise<SqliteDatabase> {
		if (this.gated) {
			this.gated = false;
			this.entered.resolve();
			await this.release.promise;
		}
		return this.source.openExisting(path);
	}

	openReadOnly(path: string): Promise<SqliteDatabase> {
		return this.source.openReadOnly(path);
	}
}

class CloseTrackingDatabase extends ForwardingDatabase {
	closeAttempts = 0;
	closeError: Error | undefined;

	override close(): void {
		this.closeAttempts++;
		this.source.close();
		if (this.closeError !== undefined) throw this.closeError;
	}
}

class CloseTrackingFactory implements SqliteDatabaseFactory {
	readonly source = createNodeSqliteFactory();
	readonly writableConnections: CloseTrackingDatabase[] = [];

	async open(path: string): Promise<SqliteDatabase> {
		const db = new CloseTrackingDatabase(await this.source.open(path));
		this.writableConnections.push(db);
		return db;
	}

	async openExisting(path: string): Promise<SqliteDatabase> {
		const db = new CloseTrackingDatabase(await this.source.openExisting(path));
		this.writableConnections.push(db);
		return db;
	}

	openReadOnly(path: string): Promise<SqliteDatabase> {
		return this.source.openReadOnly(path);
	}
}

function commitLaterSourceState(db: SqliteDatabase): void {
	const tip = storedValues.branchTip("main");
	const name = storedValues.sessionName;
	const label = storedValues.entryLabel("root");
	db.transaction(() => {
		sql`INSERT INTO entries (session_id, id, parent_id, seq, type, custom_type, timestamp, payload)
			VALUES (${"source"}, ${"child"}, ${"root"}, ${7}, ${"message"}, ${null}, ${2}, ${JSON.stringify({ message: { role: "user", content: "after", timestamp: 2 } })})`.run(
			db,
		);
		sql`INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq, entry_type)
			VALUES (${"source"}, ${"root"}, ${"child"}, ${7}, ${"message"})`.run(db);
		sql`UPDATE branch_meta SET tip_entry_id = ${"child"}, tip_seq = ${7}
			WHERE session_id = ${"source"} AND branch_id = ${"root"}`.run(db);
		for (const [namespace, key, seq, value] of [
			[tip.namespace, tip.key, 8, "child"],
			[name.namespace, name.key, 9, "after"],
			[label.namespace, label.key, 10, "after-label"],
		] as const) {
			sql`INSERT INTO scalar_values (session_id, namespace, key, seq, value)
				VALUES (${"source"}, ${namespace}, ${key}, ${seq}, ${JSON.stringify(value)})
				ON CONFLICT(session_id, namespace, key) DO UPDATE SET seq = excluded.seq, value = excluded.value`.run(db);
		}
		sql`UPDATE sessions SET message_count = ${1}, next_seq = ${11} WHERE id = ${"source"}`.run(db);
	});
}

describe("SqliteSessionRepo", () => {
	it("creates one branchless initialized session file", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});

			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const metadata = session.metadata;
			expect(metadata).toMatchObject({
				id: "session",
				createdAt: 1_700_000_000_000,
				storageVersion: 1,
			});
			expect(metadata.path).toBe(await realpath(join(directory, "session.sqlite")));

			await withDb(metadata.path, (db) => {
				expect(sql`SELECT COUNT(*) AS count FROM sessions`.get<{ count: number }>(db)).toEqual({ count: 1 });
				expect(
					sql`SELECT message_count, usage_payload, next_seq FROM sessions WHERE id = ${"session"}`.get(db),
				).toEqual({
					message_count: 0,
					usage_payload: JSON.stringify({
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					}),
					next_seq: 1,
				});
				expect(
					sql`SELECT namespace, key, seq, value FROM scalar_values WHERE session_id = ${"session"} ORDER BY seq`.all(
						db,
					),
				).toEqual([]);
				expect(sql`SELECT COUNT(*) AS count FROM list_values WHERE session_id = ${"session"}`.get(db)).toEqual({
					count: 0,
				});
			});
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("exposes explicit branch scans through the open-session facade", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			await session.mutate(
				(mutator) =>
					mutator.commit(
						[
							sessionWrites.insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
							sessionWrites.insertEntry({ id: "child", parentId: "root", type: "custom", customType: "child" }),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			expect(await session.scanBranch({ start: "child", order: "oldestFirst" }, BACKGROUND_CONTEXT)).toMatchObject([
				{ id: "root" },
				{ id: "child" },
			]);
			await session.close(BACKGROUND_CONTEXT);
			await expect(session.scanBranch({ start: "child" }, BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");
		});
	});

	it("commits an explicit mutation through the open-session facade", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const mutation = await session.beginMutation(BACKGROUND_CONTEXT);
			const result = await mutation.commit(
				[storedValues.setValue(storedValues.sessionName, "explicit")],
				BACKGROUND_CONTEXT,
			);

			expect(result.seqs).toHaveLength(1);
			expect(await mutation.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toMatchObject({
				value: "explicit",
			});
			await mutation.end(BACKGROUND_CONTEXT);
			expect(await session.getName(BACKGROUND_CONTEXT)).toBe("explicit");
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("rejects duplicate create without deleting the existing database", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const { metadata } = session;

			await expect(repo.create({ id: "session" }, BACKGROUND_CONTEXT)).rejects.toThrow();
			await withDb(metadata.path, (db) => {
				expect(sql`SELECT COUNT(*) AS count FROM sessions`.get<{ count: number }>(db)).toEqual({ count: 1 });
			});
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("lists an open session without storage-layer ownership state", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const { metadata } = session;

			await expect(repo.list(undefined, BACKGROUND_CONTEXT)).resolves.toMatchObject([
				{ id: "session", path: metadata.path },
			]);
			await withDb(metadata.path, (db) => {
				expect(
					sql`SELECT name FROM sqlite_master WHERE type = ${"table"} AND name = ${"writer_lease"}`.get(db),
				).toBeUndefined();
			});
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("ignores a stale writer_lease table from a pre-WP07 WIP database", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const created = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			await created.close(BACKGROUND_CONTEXT);
			await withDb(created.metadata.path, (db) => {
				db.exec(
					"CREATE TABLE writer_lease (session_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, fence INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL) WITHOUT ROWID",
				);
				sql`INSERT INTO writer_lease (session_id, owner_id, fence, expires_at_ms)
					VALUES (${"session"}, ${"stale"}, ${7}, ${999})`.run(db);
			});

			const reopened = await repo.open(created.metadata, BACKGROUND_CONTEXT);
			await reopened.setName("works", BACKGROUND_CONTEXT);
			await reopened.close(BACKGROUND_CONTEXT);
			await withDb(created.metadata.path, (db) => {
				expect(sql`SELECT owner_id, fence FROM writer_lease WHERE session_id = ${"session"}`.get(db)).toEqual({
					owner_id: "stale",
					fence: 7,
				});
			});
		});
	});

	it("skips corrupt and incompatible files during list discovery", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			await session.close(BACKGROUND_CONTEXT);
			await writeFile(join(directory, "corrupt.sqlite"), "not a sqlite database");
			await withDb(session.metadata.path, (db) => {
				sql`UPDATE sessions SET storage_version = ${999} WHERE id = ${"session"}`.run(db);
			});

			expect(await repo.list(undefined, BACKGROUND_CONTEXT)).toEqual([]);
		});
	});

	it("does not remove a pre-existing non-database file when create fails", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const path = join(directory, "session.sqlite");
			await writeFile(path, "not a sqlite database");

			await expect(repo.create({ id: "session" }, BACKGROUND_CONTEXT)).rejects.toThrow();
			await expect(access(path)).resolves.toBeUndefined();
		});
	});

	it("rejects delete for missing files and deletes a closed session", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const { metadata } = session;
			await session.close(BACKGROUND_CONTEXT);

			await expect(
				repo.delete({ ...metadata, path: join(directory, "missing.sqlite") }, BACKGROUND_CONTEXT),
			).rejects.toThrow();
			await repo.delete(metadata, BACKGROUND_CONTEXT);
			await expect(access(metadata.path)).rejects.toThrow();
		});
	});

	it("closes open sessions through repo close and rejects later operations", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);

			await repo.close(BACKGROUND_CONTEXT);

			await expect(session.getStats(BACKGROUND_CONTEXT)).rejects.toThrow("Session is closed");
			await expect(repo.list(undefined, BACKGROUND_CONTEXT)).rejects.toThrow("SqliteSessionRepo is closed");
			await expect(repo.create({ id: "other" }, BACKGROUND_CONTEXT)).rejects.toThrow("SqliteSessionRepo is closed");
			await expect(repo.close(BACKGROUND_CONTEXT)).resolves.toBeUndefined();
		});
	});

	it("opens a session through the version gate and rejects a duplicate local handle", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const created = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			const { metadata } = created;
			await created.close(BACKGROUND_CONTEXT);

			const opened = await repo.open(metadata, BACKGROUND_CONTEXT);
			expect(opened.metadata).toMatchObject({ id: "session", path: metadata.path });
			await expect(repo.open(metadata, BACKGROUND_CONTEXT)).rejects.toThrow("already open");
			await opened.close(BACKGROUND_CONTEXT);
		});
	});

	it("isolates sessions stored in one shared SQLite container", async () => {
		await withTempDir(async (directory) => {
			const databasePath = join(directory, "sessions.sqlite");
			const repo = new SqliteSessionRepo({
				directory,
				databasePath,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});
			const left = await repo.create({ id: "left" }, BACKGROUND_CONTEXT);
			const right = await repo.create({ id: "right" }, BACKGROUND_CONTEXT);

			expect(left.metadata.path).toBe(await realpath(databasePath));
			expect(right.metadata.path).toBe(await realpath(databasePath));
			await left.mutate(
				(mutator) =>
					mutator.commit(
						[
							sessionWrites.insertEntry({ id: "left-root", parentId: null, type: "custom", customType: "left" }),
							storedValues.setValue(storedValues.sessionName, "left-name"),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);
			await right.mutate(
				(mutator) =>
					mutator.commit(
						[
							sessionWrites.insertEntry({
								id: "right-root",
								parentId: null,
								type: "custom",
								customType: "right",
							}),
							storedValues.setValue(storedValues.sessionName, "right-name"),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			expect((await repo.list(undefined, BACKGROUND_CONTEXT)).map((metadata) => metadata.id).sort()).toEqual([
				"left",
				"right",
			]);
			expect(await left.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toMatchObject({
				value: "left-name",
			});
			expect(await right.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toMatchObject({
				value: "right-name",
			});
			expect((await left.getEntries(["left-root", "right-root"], BACKGROUND_CONTEXT)).has("right-root")).toBe(false);
			expect((await right.getEntries(["left-root", "right-root"], BACKGROUND_CONTEXT)).has("left-root")).toBe(false);

			await Promise.all([left.close(BACKGROUND_CONTEXT), right.close(BACKGROUND_CONTEXT)]);
		});
	});

	it("does not copy usage ledger rows when forking", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1_700_000_000_000,
			});
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			await source.mutate(
				(mutator) =>
					mutator.commit(
						[
							sessionWrites.insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
							sessionWrites.insertEntry({
								id: "child",
								parentId: "root",
								type: "message",
								message: { role: "user", content: "child", timestamp: 1 },
							}),
							storedValues.setValue(storedValues.branchTip("main"), "child"),
							storedValues.setValue(storedValues.laneConfig("main"), TEST_LANE_CONFIGURATION),
							storedValues.setValue(storedValues.laneState("main"), IDLE_LANE_STATE),
							sessionWrites.insertUsage({
								id: "usage",
								adjustment: false,
								usage: {
									input: 1,
									output: 1,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 2,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
							}),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			await source.close(BACKGROUND_CONTEXT);
			const fork = await repo.fork(
				source.metadata,
				{ id: "fork", scope: "branch", branch: "main", entryId: "child" },
				BACKGROUND_CONTEXT,
			);

			await withDb(fork.metadata.path, (db) => {
				expect(
					sql`SELECT COUNT(*) AS count FROM usage_ledger WHERE session_id = ${"fork"}`.get<{ count: number }>(db),
				).toEqual({ count: 0 });
			});
			await Promise.all([source.close(BACKGROUND_CONTEXT), fork.close(BACKGROUND_CONTEXT)]);
		});
	});

	it("does not create databases for missing open, list, fork, or delete targets", async () => {
		await withTempDir(async (root) => {
			const directory = join(root, "missing-directory");
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const missing = {
				id: "missing",
				createdAt: 1,
				storageVersion: 1,
				path: join(directory, "missing.sqlite"),
			};

			await expect(repo.list(undefined, BACKGROUND_CONTEXT)).resolves.toEqual([]);
			expect(await pathExists(directory)).toBe(false);
			await expect(repo.open(missing, BACKGROUND_CONTEXT)).rejects.toThrow();
			await expect(repo.delete(missing, BACKGROUND_CONTEXT)).rejects.toThrow();
			await expect(repo.fork(missing, { id: "fork", scope: "tree" }, BACKGROUND_CONTEXT)).rejects.toThrow();
			expect(await pathExists(missing.path)).toBe(false);
			expect(await pathExists(join(directory, "fork.sqlite"))).toBe(false);
		});
	});

	it("reserves deletion against local create, open, and fork destinations", async () => {
		await withTempDir(async (directory) => {
			const databaseFactory = new GatedOpenExistingFactory();
			const repo = new SqliteSessionRepo({ directory, databaseFactory, now: () => 1 });
			const target = await repo.create({ id: "target" }, BACKGROUND_CONTEXT);
			const source = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
			await expect(repo.delete(target.metadata, BACKGROUND_CONTEXT)).rejects.toThrow("already open");
			// The host closes a worker before deletion; only same-repository exclusion is promised here.
			await target.close(BACKGROUND_CONTEXT);
			databaseFactory.arm();

			const deleting = repo.delete(target.metadata, BACKGROUND_CONTEXT);
			await databaseFactory.entered.promise;
			await expect(repo.create({ id: "target" }, BACKGROUND_CONTEXT)).rejects.toThrow("already open");
			await expect(repo.open(target.metadata, BACKGROUND_CONTEXT)).rejects.toThrow("already open");
			await expect(repo.fork(source.metadata, { id: "target", scope: "tree" }, BACKGROUND_CONTEXT)).rejects.toThrow(
				"already open",
			);
			databaseFactory.release.resolve();
			await deleting;
			await source.close(BACKGROUND_CONTEXT);
		});
	});

	it("deletes only the selected Session from a shared container", async () => {
		await withTempDir(async (directory) => {
			const databasePath = join(directory, "shared.sqlite");
			const repo = new SqliteSessionRepo({
				directory,
				databasePath,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const removed = await repo.create({ id: "removed" }, BACKGROUND_CONTEXT);
			const retained = await repo.create({ id: "retained" }, BACKGROUND_CONTEXT);
			await removed.setName("removed", BACKGROUND_CONTEXT);
			await retained.setName("retained", BACKGROUND_CONTEXT);
			await removed.close(BACKGROUND_CONTEXT);

			await repo.delete(removed.metadata, BACKGROUND_CONTEXT);

			expect((await repo.list(undefined, BACKGROUND_CONTEXT)).map(({ id }) => id)).toEqual(["retained"]);
			expect(await retained.getName(BACKGROUND_CONTEXT)).toBe("retained");
			await expect(repo.open(removed.metadata, BACKGROUND_CONTEXT)).rejects.toThrow("Unknown SQLite session");
			await retained.close(BACKGROUND_CONTEXT);
		});
	});

	it("removes per-file WAL and SHM sidecars", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);
			await session.close(BACKGROUND_CONTEXT);
			await writeFile(`${session.metadata.path}-wal`, "");
			await writeFile(`${session.metadata.path}-shm`, "");

			await repo.delete(session.metadata, BACKGROUND_CONTEXT);

			await expect(access(session.metadata.path)).rejects.toThrow();
			await expect(access(`${session.metadata.path}-wal`)).rejects.toThrow();
			await expect(access(`${session.metadata.path}-shm`)).rejects.toThrow();
		});
	});

	it("creates the parent of a custom shared-container path", async () => {
		await withTempDir(async (directory) => {
			const databasePath = join(directory, "nested", "containers", "sessions.sqlite");
			const repo = new SqliteSessionRepo({
				directory: join(directory, "unrelated"),
				databasePath,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});

			const session = await repo.create({ id: "session" }, BACKGROUND_CONTEXT);

			expect(session.metadata.path).toBe(await realpath(databasePath));
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("encodes unsafe explicit IDs inside the repository directory and round-trips them", async () => {
		await withTempDir(async (directory) => {
			const repo = new SqliteSessionRepo({
				directory,
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const ids = ["../escape", "slash/id", "back\\slash", "percent%id", "..", "dots...id", "ユニコード"];
			const metadata = [];
			for (const id of ids) {
				const session = await repo.create({ id }, BACKGROUND_CONTEXT);
				metadata.push(session.metadata);
				await session.close(BACKGROUND_CONTEXT);
			}
			const canonicalDirectory = await realpath(directory);
			for (const stored of metadata) {
				const fromDirectory = relative(canonicalDirectory, stored.path);
				expect(isAbsolute(fromDirectory)).toBe(false);
				expect(fromDirectory.startsWith(".."), stored.id).toBe(false);
				expect(dirname(stored.path)).toBe(canonicalDirectory);
			}
			expect((await repo.list(undefined, BACKGROUND_CONTEXT)).map(({ id }) => id).sort()).toEqual([...ids].sort());
			for (const stored of metadata) {
				const reopened = await repo.open(stored, BACKGROUND_CONTEXT);
				expect(reopened.metadata.id).toBe(stored.id);
				await reopened.close(BACKGROUND_CONTEXT);
			}
			const fork = await repo.fork(metadata[0]!, { id: "fork/../%", scope: "tree" }, BACKGROUND_CONTEXT);
			expect(fork.metadata).toMatchObject({ id: "fork/../%", parentSessionId: "../escape" });
			expect(dirname(fork.metadata.path)).toBe(canonicalDirectory);
			await fork.close(BACKGROUND_CONTEXT);
		});
	});

	it("uses exact physical identity for foreign fork sources and rejects foreign writable metadata", async () => {
		await withTempDir(async (root) => {
			const leftRepo = new SqliteSessionRepo({
				directory: join(root, "left"),
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const rightRepo = new SqliteSessionRepo({
				directory: join(root, "right"),
				databaseFactory: createNodeSqliteFactory(),
				now: () => 1,
			});
			const left = await leftRepo.create({ id: "same" }, BACKGROUND_CONTEXT);
			const right = await rightRepo.create({ id: "same" }, BACKGROUND_CONTEXT);
			await left.mutate(
				(mutator) =>
					mutator.commit(
						[
							sessionWrites.insertEntry({ id: "left-root", parentId: null, type: "custom", customType: "left" }),
							storedValues.setValue(storedValues.branchTip("main"), "left-root"),
							storedValues.setValue(storedValues.laneConfig("main"), TEST_LANE_CONFIGURATION),
							storedValues.setValue(storedValues.laneState("main"), IDLE_LANE_STATE),
							storedValues.setValue(storedValues.sessionName, "left"),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);
			await right.mutate(
				(mutator) =>
					mutator.commit(
						[
							sessionWrites.insertEntry({
								id: "right-root",
								parentId: null,
								type: "custom",
								customType: "right",
							}),
							storedValues.setValue(storedValues.branchTip("main"), "right-root"),
							storedValues.setValue(storedValues.sessionName, "right"),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			const fork = await rightRepo.fork(
				left.metadata,
				{ id: "fork-left", scope: "branch", branch: "main" },
				BACKGROUND_CONTEXT,
			);
			expect((await fork.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id }) => id)).toEqual([
				"left-root",
			]);
			expect(await fork.getName(BACKGROUND_CONTEXT)).toBe("left");
			await right.close(BACKGROUND_CONTEXT);
			await expect(rightRepo.open(left.metadata, BACKGROUND_CONTEXT)).rejects.toThrow("outside this repository");
			await expect(rightRepo.delete(left.metadata, BACKGROUND_CONTEXT)).rejects.toThrow("outside this repository");
			await Promise.all([left.close(BACKGROUND_CONTEXT), fork.close(BACKGROUND_CONTEXT)]);
		});
	});

	for (const layout of ["per-file", "shared"] as const) {
		it(`forks a live ${layout} source through one coherent read-only WAL snapshot`, async () => {
			await withTempDir(async (directory) => {
				const databasePath = layout === "shared" ? join(directory, "shared.sqlite") : undefined;
				const workerRepo = new SqliteSessionRepo({
					directory,
					...(databasePath === undefined ? {} : { databasePath }),
					databaseFactory: createNodeSqliteFactory(),
					now: () => 1,
				});
				const source = await workerRepo.create({ id: "source" }, BACKGROUND_CONTEXT);
				await source.mutate(
					(mutator) =>
						mutator.commit(
							[
								sessionWrites.insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
								storedValues.setValue(storedValues.branchTip("main"), "root"),
								storedValues.setValue(storedValues.laneConfig("main"), TEST_LANE_CONFIGURATION),
								storedValues.setValue(storedValues.laneState("main"), IDLE_LANE_STATE),
								storedValues.setValue(storedValues.sessionName, "before"),
								storedValues.setValue(storedValues.entryLabel("root"), "before-label"),
							],
							BACKGROUND_CONTEXT,
						),
					BACKGROUND_CONTEXT,
				);
				const writerDb = await createNodeSqliteFactory().openExisting(source.metadata.path);
				writerDb.exec("PRAGMA busy_timeout = 5000;");
				let laterCommitCompleted = false;
				const databaseFactory = new SnapshotBoundaryFactory(() => {
					if (laterCommitCompleted) return;
					commitLaterSourceState(writerDb);
					laterCommitCompleted = true;
				});
				const serverRepo = new SqliteSessionRepo({
					directory,
					...(databasePath === undefined ? {} : { databasePath }),
					databaseFactory,
					now: () => 2,
				});

				const first = await serverRepo.fork(
					source.metadata,
					{ id: "first-fork", scope: "branch", branch: "main" },
					BACKGROUND_CONTEXT,
				);

				expect(laterCommitCompleted).toBe(true);
				expect(databaseFactory.readOnlyOpenCount).toBe(1);
				expect((await first.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id }) => id)).toEqual([
					"root",
				]);
				expect(await first.getName(BACKGROUND_CONTEXT)).toBe("before");
				expect(await first.getLabel("root", BACKGROUND_CONTEXT)).toBe("before-label");
				await expect((await first.branch("main", BACKGROUND_CONTEXT))?.getTipId(BACKGROUND_CONTEXT)).resolves.toBe(
					"root",
				);
				expect((await first.getStats(BACKGROUND_CONTEXT)).messageCount).toBe(0);

				const second = await serverRepo.fork(
					source.metadata,
					{ id: "second-fork", scope: "branch", branch: "main" },
					BACKGROUND_CONTEXT,
				);
				expect(databaseFactory.readOnlyOpenCount).toBe(2);
				expect((await second.findEntries({ order: "asc" }, BACKGROUND_CONTEXT)).map(({ id }) => id)).toEqual([
					"root",
					"child",
				]);
				expect(await second.getName(BACKGROUND_CONTEXT)).toBe("after");
				expect(await second.getLabel("root", BACKGROUND_CONTEXT)).toBe("after-label");
				await expect((await second.branch("main", BACKGROUND_CONTEXT))?.getTipId(BACKGROUND_CONTEXT)).resolves.toBe(
					"child",
				);
				expect((await second.getStats(BACKGROUND_CONTEXT)).messageCount).toBe(1);

				writerDb.close();
				await Promise.all([
					source.close(BACKGROUND_CONTEXT),
					first.close(BACKGROUND_CONTEXT),
					second.close(BACKGROUND_CONTEXT),
				]);
			});
		});
	}

	it("waits for every Session close and reports one or multiple failures after settlement", async () => {
		await withTempDir(async (directory) => {
			const multipleFactory = new CloseTrackingFactory();
			const multipleRepo = new SqliteSessionRepo({
				directory: join(directory, "multiple"),
				databaseFactory: multipleFactory,
				now: () => 1,
			});
			await multipleRepo.create({ id: "first" }, BACKGROUND_CONTEXT);
			await multipleRepo.create({ id: "second" }, BACKGROUND_CONTEXT);
			await multipleRepo.create({ id: "third" }, BACKGROUND_CONTEXT);
			const firstError = new Error("first close failed");
			const secondError = new Error("second close failed");
			multipleFactory.writableConnections[0]!.closeError = firstError;
			multipleFactory.writableConnections[1]!.closeError = secondError;

			const multipleClose = multipleRepo.close(BACKGROUND_CONTEXT);
			expect(multipleRepo.close(BACKGROUND_CONTEXT)).toBe(multipleClose);
			let multipleFailure: unknown;
			try {
				await multipleClose;
			} catch (error) {
				multipleFailure = error;
			}
			expect(multipleFailure).toBeInstanceOf(AggregateError);
			if (!(multipleFailure instanceof AggregateError)) throw new Error("Expected AggregateError");
			expect(multipleFailure.errors).toEqual([firstError, secondError]);
			expect(multipleFactory.writableConnections.map(({ closeAttempts }) => closeAttempts)).toEqual([1, 1, 1]);

			const singleFactory = new CloseTrackingFactory();
			const singleRepo = new SqliteSessionRepo({
				directory: join(directory, "single"),
				databaseFactory: singleFactory,
				now: () => 1,
			});
			await singleRepo.create({ id: "first" }, BACKGROUND_CONTEXT);
			await singleRepo.create({ id: "second" }, BACKGROUND_CONTEXT);
			const singleError = new Error("single close failed");
			singleFactory.writableConnections[0]!.closeError = singleError;

			await expect(singleRepo.close(BACKGROUND_CONTEXT)).rejects.toBe(singleError);
			expect(singleFactory.writableConnections.map(({ closeAttempts }) => closeAttempts)).toEqual([1, 1]);
		});
	});
});
