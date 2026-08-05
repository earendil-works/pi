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

describe("SQLite FTS5 session search", () => {
	it("matches trigrams within one cwd", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		await using fixture = createSqliteFixture({ env, sqlite, databasePath });
		const { repository: repo, search } = fixture;
		const included = await repo.create({ cwd: root, id: "included" });
		const excluded = await repo.create({ cwd: `${root}/other`, id: "excluded" });
		const entryId = await included.appendMessage(createUserMessage("Find the auth defect"));
		await excluded.appendMessage(createUserMessage("Find the auth defect"));

		await expect(search.search({ text: "auth", cwd: root })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "included" }) }),
		]);
		await expect(search.search({ text: "uth", cwd: root })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "included" }) }),
		]);
	});

	it("handles quoted search text without exposing FTS syntax", async () => {
		const root = createTempDir();
		await using fixture = createSqliteFixture({
			env: new NodeExecutionEnv({ cwd: root }),
			sqlite: createNodeSqliteFactory(),
			databasePath: join(root, "sessions.sqlite"),
		});
		const { search } = fixture;

		await expect(search.search({ text: 'missing "phrase"' })).resolves.toEqual([]);
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
		await expect(search.search({ text: "auth" })).resolves.toHaveLength(1);

		await repository.delete(await session.getMetadata());

		await expect(search.search({ text: "auth" })).resolves.toEqual([]);
	});

	it("does not initialize FTS for canonical writes or blank searches", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const databasePath = join(root, "sessions.sqlite");
		await using fixture = createSqliteFixture({ env, sqlite, databasePath });
		const { repository: repo, search } = fixture;
		await expect(search.search({ text: "  " })).resolves.toEqual([]);
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
		await search.search({ text: "initialize" });
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
		await search.search({ text: "initialize" });
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

		await expect(search.search({ text: "auth" })).rejects.toThrow("setup failed");
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

		await expect(search.search({ text: "auth" })).resolves.toEqual([]);
		const session = await repo.create({ cwd: root, id: "session-1" });
		const entryId = await session.appendMessage(createUserMessage("Find the auth defect"));

		await expect(search.search({ text: "auth" })).resolves.toEqual([
			expect.objectContaining({ entryId, metadata: expect.objectContaining({ id: "session-1" }) }),
		]);
		await expect(session.appendMessage(createUserMessage("Still writable"))).resolves.toBeTypeOf("string");
	});
});
