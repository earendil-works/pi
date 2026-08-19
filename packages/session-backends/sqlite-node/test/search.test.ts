import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, createSqliteSessionSearch, SqliteSessionRepository } from "../src/index.ts";
import { createSetupFailureSqlite, createTempDir, createUserMessage, getSqliteEntries } from "./test-utils.ts";

function createSqliteFixture(options: ConstructorParameters<typeof SqliteSessionRepository>[0]) {
	const repository = new SqliteSessionRepository(options);
	return {
		repository,
		search: createSqliteSessionSearch(options),
		[Symbol.asyncDispose]: () => repository[Symbol.asyncDispose](),
	};
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iterable) items.push(item);
	return items;
}

describe("SQLite FTS5 session search", () => {
	it("matches trigrams", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		await using fixture = createSqliteFixture({ env, sqlite, databasePath });
		const { repository: repo, search } = fixture;
		const included = await repo.create({ cwd: root, id: "included", metadata: { name: "application-owned" } });
		const excluded = await repo.create({ cwd: `${root}/other`, id: "excluded" });
		const entryId = await included.appendMessage(createUserMessage("Find the auth defect"));
		await included.setName("Canonical name");
		const excludedEntryId = await excluded.appendMessage(createUserMessage("Find the auth defect"));

		const authHits = await collect(search.search("auth"));
		expect(authHits).toHaveLength(2);
		expect(authHits).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sessionId: "included",
					entryId,
					timestamp: expect.any(Number),
					metadata: expect.objectContaining({
						id: "included",
						createdAt: expect.any(Number),
						name: "Canonical name",
						metadata: { name: "application-owned" },
					}),
				}),
				expect.objectContaining({ sessionId: "excluded", entryId: excludedEntryId }),
			]),
		);
		expect(await collect(search.search("uth"))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sessionId: "included",
					entryId,
					metadata: expect.objectContaining({ id: "included" }),
				}),
				expect.objectContaining({ sessionId: "excluded", entryId: excludedEntryId }),
			]),
		);
	});

	it("omits a cleared session name from search metadata", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		await using fixture = createSqliteFixture({ env, sqlite, databasePath });
		const { repository, search } = fixture;
		const session = await repository.create({ cwd: root, id: "session-1" });
		const entryId = await session.appendMessage(createUserMessage("Find the auth defect"));
		await session.setName("Temporary");
		await session.setName(undefined);

		const [result] = await collect(search.search("auth"));
		expect(result).toMatchObject({ sessionId: "session-1", entryId, metadata: { id: "session-1" } });
		expect(result?.metadata).not.toHaveProperty("name");
	});

	it("handles quoted search text without exposing FTS syntax", async () => {
		const root = createTempDir();
		await using fixture = createSqliteFixture({
			env: new NodeExecutionEnv({ cwd: root }),
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "sessions.sqlite"),
		});
		const { search } = fixture;

		expect(await collect(search.search('missing "phrase"'))).toEqual([]);
	});

	it("rebuilds existing entries when FTS is first initialized", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const databasePath = join(root, "sessions.sqlite");
		await using fixture = createSqliteFixture({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath,
		});
		const { repository, search } = fixture;
		const session = await repository.create({ cwd: root, id: "session-1" });
		const entryId = await session.appendMessage(createUserMessage("Find the auth defect"));

		expect(await collect(search.search("auth"))).toEqual([
			expect.objectContaining({ sessionId: "session-1", entryId }),
		]);
	});

	it("honors entry type filters", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const databasePath = join(root, "sessions.sqlite");
		await using fixture = createSqliteFixture({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath,
		});
		const { repository, search } = fixture;
		const session = await repository.create({ cwd: root, id: "session-1" });
		const messageEntryId = await session.appendMessage(createUserMessage("Find the auth defect"));
		await session.appendCustomEntry("note", { text: "Find the auth custom entry" });

		expect(await collect(search.search("auth", { entryTypes: ["message"] }))).toEqual([
			expect.objectContaining({ sessionId: "session-1", entryId: messageEntryId }),
		]);
	});

	it("honors result limits", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const databasePath = join(root, "sessions.sqlite");
		await using fixture = createSqliteFixture({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath,
		});
		const { repository, search } = fixture;
		const first = await repository.create({ cwd: root, id: "session-1" });
		const second = await repository.create({ cwd: root, id: "session-2" });
		await first.appendMessage(createUserMessage("Find the auth defect"));
		await second.appendMessage(createUserMessage("Find the auth defect too"));

		expect(await collect(search.search("auth", { limit: 1 }))).toHaveLength(1);
		expect(await collect(search.search("auth", { limit: 0 }))).toEqual([]);
	});

	it("removes deleted session entries from the index", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const databasePath = join(root, "sessions.sqlite");
		await using fixture = createSqliteFixture({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath,
		});
		const { repository, search } = fixture;
		const session = await repository.create({ cwd: root, id: "session-1" });
		await session.appendMessage(createUserMessage("Find the auth defect"));
		expect(await collect(search.search("auth"))).toHaveLength(1);

		await repository.delete(await session.getMetadata());

		expect(await collect(search.search("auth"))).toEqual([]);
	});

	it("indexes and removes session entries through triggers after FTS initialization", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const databasePath = join(root, "sessions.sqlite");
		await using fixture = createSqliteFixture({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath,
		});
		const { repository, search } = fixture;
		expect(await collect(search.search("auth"))).toEqual([]);
		const session = await repository.create({ cwd: root, id: "session-1" });
		await session.appendMessage(createUserMessage("Find the auth defect"));
		expect(await collect(search.search("auth"))).toHaveLength(1);

		await repository.delete(await session.getMetadata());

		expect(await collect(search.search("auth"))).toEqual([]);
	});

	it("removes deleted entries from FTS through triggers", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		await using fixture = createSqliteFixture({ env, sqlite, databasePath });
		const { repository, search } = fixture;
		const session = await repository.create({ cwd: root, id: "session-1" });
		const entryId = await session.appendMessage(createUserMessage("Find the auth defect"));
		expect(await collect(search.search("auth"))).toHaveLength(1);

		const db = await sqlite.open(databasePath);
		try {
			await db.prepare("DELETE FROM entries WHERE session_id = ? AND id = ?").run("session-1", entryId);
		} finally {
			await db.close();
		}

		expect(await collect(search.search("auth"))).toEqual([]);
	});

	it("does not initialize FTS for canonical writes or blank searches", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		await using fixture = createSqliteFixture({ env, sqlite, databasePath });
		const { repository: repo, search } = fixture;
		expect(await collect(search.search("  "))).toEqual([]);
		const session = await repo.create({ cwd: root, id: "session-1" });

		const db = await sqlite.open(databasePath);
		try {
			const fts = await db
				.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'session_search_fts'")
				.get<{ found: number }>();
			expect(fts).toBeUndefined();
		} finally {
			await db.close();
		}
		await expect(session.appendMessage(createUserMessage("still writable"))).resolves.toBeTypeOf("string");
	});

	it("rolls back canonical appends when co-located FTS trigger writes fail", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		await using fixture = createSqliteFixture({ env, sqlite, databasePath });
		const { repository: repo, search } = fixture;
		await collect(search.search("initialize"));
		const session = await repo.create({ cwd: root, id: "session-1" });

		const db = await sqlite.open(databasePath);
		try {
			await db.exec("DROP TABLE session_search_fts");
		} finally {
			await db.close();
		}

		await expect(session.appendMessage(createUserMessage("must roll back"))).rejects.toThrow();
		await expect(getSqliteEntries(session)).resolves.toEqual([]);
	});

	it("rolls back canonical deletion when co-located FTS cleanup fails", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		await using fixture = createSqliteFixture({ env, sqlite, databasePath });
		const { repository: repo, search } = fixture;
		await collect(search.search("initialize"));
		const session = await repo.create({ cwd: root, id: "session-1" });
		await session.appendMessage(createUserMessage("must remain"));
		const metadata = await session.getMetadata();

		const db = await sqlite.open(databasePath);
		try {
			await db.exec("DROP TABLE session_search_fts");
		} finally {
			await db.close();
		}

		await expect(repo.delete(metadata)).rejects.toThrow();
		const reopened = await repo.open(metadata);
		await expect(getSqliteEntries(reopened)).resolves.toHaveLength(1);
	});

	it("closes the database when search setup fails", async () => {
		const root = createTempDir();
		const { sqlite, counts } = createSetupFailureSqlite();
		const search = createSqliteSessionSearch({
			env: new NodeExecutionEnv({ cwd: root }),
			sqlite,
			databasePath: join(root, "sessions.sqlite"),
		});

		await expect(collect(search.search("auth"))).rejects.toThrow("setup failed");
		expect(counts.closes).toBe(1);
	});

	it("initializes canonical storage when searched before the first session is created", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		await using fixture = createSqliteFixture({
			env,
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "sessions.sqlite"),
		});
		const { repository: repo, search } = fixture;

		expect(await collect(search.search("auth"))).toEqual([]);
		const session = await repo.create({ cwd: root, id: "session-1" });
		const entryId = await session.appendMessage(createUserMessage("Find the auth defect"));

		expect(await collect(search.search("auth"))).toEqual([
			expect.objectContaining({
				sessionId: "session-1",
				entryId,
				metadata: expect.objectContaining({ id: "session-1" }),
			}),
		]);
		await expect(session.appendMessage(createUserMessage("Still writable"))).resolves.toBeTypeOf("string");
	});
});
