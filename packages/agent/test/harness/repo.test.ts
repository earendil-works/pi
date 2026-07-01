import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { JsonlSessionRepo } from "../../src/harness/session/jsonl-repo.ts";
import { InMemorySessionRepo } from "../../src/harness/session/memory-repo.ts";
import { SessionLifecycle } from "../../src/harness/session/session-lifecycle.ts";
import { SqliteSessionRepo } from "../../src/harness/session/sqlite/repo.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./session-test-utils.ts";

describe("InMemorySessionRepo", () => {
	it("opens, deletes, and forks by metadata", async () => {
		const repo = new InMemorySessionRepo();
		const session = await repo.create({ id: "session-1" });
		const metadata = await session.getMetadata();
		const user1 = await session.appendMessage(createUserMessage("one"));
		const assistant1 = await session.appendMessage(createAssistantMessage("two"));
		const user2 = await session.appendMessage(createUserMessage("three"));
		expect(await repo.open(metadata)).toBe(session);
		expect((await repo.list()).map((info) => info.id)).toEqual(["session-1"]);
		const fork = await repo.fork(metadata, { entryId: user2, id: "session-2" });
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.fork(metadata, { id: "session-3" });
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		await repo.delete(metadata);
		await expect(repo.open(metadata)).rejects.toThrow("Session not found: session-1");
	});
});

describe("JsonlSessionRepo", () => {
	it("stores sessions below encoded cwd directories and lists by cwd", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const cwd = "/tmp/my-project";
		const otherCwd = "/tmp/other-project";
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ cwd, id: "019de8c2-de29-73e9-ae0c-e134db34c447" });
		const otherSession = await repo.create({ cwd: otherCwd, id: "other-session" });
		const metadata = await session.getMetadata();
		const otherMetadata = await otherSession.getMetadata();
		expect(metadata.path).toContain("--tmp-my-project--");
		expect(otherMetadata.path).toContain("--tmp-other-project--");
		expect(existsSync(metadata.path)).toBe(true);
		expect((await repo.list({ cwd })).map((sessionMetadata) => sessionMetadata.id)).toEqual([metadata.id]);
		expect((await repo.list()).map((sessionMetadata) => sessionMetadata.id).sort()).toEqual(
			[metadata.id, otherMetadata.id].sort(),
		);
	});

	it("opens, deletes, and forks by metadata", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const source = await repo.create({ cwd: "/tmp/source", id: "source-session" });
		const sourceMetadata = await source.getMetadata();
		const user1 = await source.appendMessage(createUserMessage("one"));
		const assistant1 = await source.appendMessage(createAssistantMessage("two"));
		const user2 = await source.appendMessage(createUserMessage("three"));
		await expect((await repo.open(sourceMetadata)).getMetadata()).resolves.toEqual(sourceMetadata);
		const fork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "fork-session", entryId: user2 });
		const forkMetadata = await fork.getMetadata();
		expect(forkMetadata.cwd).toBe("/tmp/target");
		expect(forkMetadata.parentSessionPath).toBe(sourceMetadata.path);
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1]);
		const fullFork = await repo.fork(sourceMetadata, { cwd: "/tmp/target", id: "full-fork-session" });
		expect((await fullFork.getEntries()).map((entry) => entry.id)).toEqual([user1, assistant1, user2]);
		await repo.delete(sourceMetadata);
		expect(existsSync(sourceMetadata.path)).toBe(false);
		await expect(repo.open(sourceMetadata)).rejects.toThrow("Session not found");
	});
});

describe("SessionLifecycle", () => {
	it("mirrors create, open, fork, and delete to sqlite when PI_SQLITE_SESSION_STORAGE=1", async () => {
		const previous = process.env.PI_SQLITE_SESSION_STORAGE;
		process.env.PI_SQLITE_SESSION_STORAGE = "1";
		try {
			const root = createTempDir();
			const env = new NodeExecutionEnv({ cwd: root });
			const jsonlRepo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
			const databasePath = join(root, "sessions.sqlite");
			const sqliteRepo = new SqliteSessionRepo({ env, databasePath });
			const lifecycle = new SessionLifecycle({ jsonlRepo, sqliteRepo });
			const session = await lifecycle.create({ cwd: "/tmp/source", id: "source-session" });
			await session.appendMessage(createUserMessage("one"));
			await session.appendMessage(createAssistantMessage("two"));
			await session.moveTo(null);
			const sqliteSession = await sqliteRepo.open({
				id: "source-session",
				cwd: "/tmp/source",
				createdAt: (await session.getMetadata()).createdAt,
				path: databasePath,
			});
			expect((await sqliteSession.getEntries()).map((entry) => entry.id)).toEqual(
				(await session.getEntries()).map((entry) => entry.id),
			);
			const reopened = await lifecycle.open(await session.getMetadata());
			expect((await reopened.getEntries()).map((entry) => entry.id)).toEqual(
				(await session.getEntries()).map((entry) => entry.id),
			);
			const fork = await lifecycle.fork(await session.getMetadata(), { cwd: "/tmp/target", id: "fork-session" });
			expect((await fork.getEntries()).map((entry) => entry.id)).toEqual(
				(await session.getEntries()).map((entry) => entry.id),
			);
			await lifecycle.delete(await session.getMetadata());
			expect(await sqliteRepo.list({ cwd: "/tmp/source" })).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.PI_SQLITE_SESSION_STORAGE;
			else process.env.PI_SQLITE_SESSION_STORAGE = previous;
		}
	});
});
