import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodingAgentSqliteSessionRepository } from "../src/core/sqlite-session-repository.ts";

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function createAssistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("CodingAgentSqliteSessionRepository", () => {
	let root: string;
	let databasePath: string;
	let repo: CodingAgentSqliteSessionRepository;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-coding-sqlite-"));
		databasePath = join(root, "custom", "sessions.sqlite");
		repo = new CodingAgentSqliteSessionRepository(databasePath);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("creates, lists, opens, and closes a durable session", async () => {
		const cwd = join(root, "project");
		const session = await repo.create({ cwd, id: "session-1" });
		await session.appendMessage(createUserMessage("one"));
		await session.appendMessage(createAssistantMessage("two"));
		const metadata = await session.getMetadata();
		expect(repo.toReference(metadata)).toEqual({
			backend: "sqlite",
			id: "session-1",
			storagePath: databasePath,
		});
		await session.close();
		await session.close();

		expect((await repo.list(cwd)).map((item) => item.id)).toEqual(["session-1"]);
		expect(await repo.list(join(root, "other"))).toEqual([]);
		const reopened = await repo.openById("session-1");
		expect((await reopened.buildContext()).messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		await reopened.close();
	});

	it("continues the most recent cwd session or creates one", async () => {
		const cwd = join(root, "project");
		const created = await repo.continueRecent(cwd);
		const createdId = (await created.getMetadata()).id;
		await created.appendMessage(createUserMessage("persisted"));
		await created.close();

		const continued = await repo.continueRecent(cwd);
		expect((await continued.getMetadata()).id).toBe(createdId);
		expect((await continued.buildContext()).messages).toHaveLength(1);
		await continued.close();
	});

	it("forks and deletes sessions by id", async () => {
		const source = await repo.create({ cwd: root, id: "source" });
		await source.appendMessage(createUserMessage("one"));
		await source.appendMessage(createAssistantMessage("two"));
		await source.close();

		const fork = await repo.fork("source", { cwd: root, id: "fork" });
		expect((await fork.buildContext()).messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		await fork.close();
		await repo.deleteById("source");
		expect((await repo.list()).map((item) => item.id)).toEqual(["fork"]);
		await expect(repo.openById("source")).rejects.toMatchObject({ code: "not_found" });
	});

	it("discards empty sessions but retains sessions with messages", async () => {
		const empty = await repo.create({ cwd: root, id: "empty" });
		expect(await repo.discardIfEmpty(empty)).toBe(true);
		expect(await repo.list()).toEqual([]);

		const retained = await repo.create({ cwd: root, id: "retained" });
		await retained.appendMessage(createUserMessage("one"));
		expect(await repo.discardIfEmpty(retained)).toBe(false);
		expect((await repo.list()).map((item) => item.id)).toEqual(["retained"]);
	});

	it("supports repeated open and close cycles", async () => {
		const created = await repo.create({ cwd: root, id: "session-1" });
		await created.appendMessage(createUserMessage("one"));
		await created.close();
		for (let index = 0; index < 5; index += 1) {
			const opened = await repo.openById("session-1");
			expect(await opened.getLeafId()).not.toBeNull();
			await opened.close();
		}
	});
});
