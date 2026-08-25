import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStorage, JsonlSessionRepo, Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createNodeSqliteFactory, SqliteSessionRepository } from "@earendil-works/pi-session-backend-sqlite-node";
import { afterEach, describe, expect, it } from "vitest";
import { BackendSessionManager } from "../src/core/backend-session-manager.ts";

function user(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

function assistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "test",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

const tempDirs: string[] = [];
function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "pi-backend-manager-"));
	tempDirs.push(path);
	return path;
}

async function memoryManager(): Promise<BackendSessionManager> {
	return BackendSessionManager.hydrate(
		new Session(new InMemorySessionStorage({ id: "session-1", createdAt: Date.now() })),
		"memory",
	);
}

async function jsonlManager(): Promise<BackendSessionManager> {
	const root = tempDir();
	const repository = new JsonlSessionRepo({ fs: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
	return BackendSessionManager.hydrate(await repository.create({ cwd: root, id: "session-1" }), "jsonl");
}

async function sqliteManager(): Promise<BackendSessionManager> {
	const root = tempDir();
	const repository = new SqliteSessionRepository({
		env: new NodeExecutionEnv({ cwd: root }),
		sqlite: createNodeSqliteFactory(),
		databasePath: join(root, "sessions.sqlite"),
	});
	return BackendSessionManager.hydrate(await repository.create({ cwd: root, id: "session-1" }), "sqlite", () =>
		repository.close(),
	);
}

for (const [name, create] of [
	["memory", memoryManager],
	["jsonl", jsonlManager],
	["sqlite", sqliteManager],
] as const) {
	describe(`BackendSessionManager (${name})`, () => {
		it("keeps synchronous reads aligned after durable mutations", async () => {
			const manager = await create();
			expect(manager.getHeader()).toMatchObject({
				type: "session",
				version: 3,
				id: "session-1",
			});
			const rootId = await manager.appendMessage(user("one"));
			await manager.appendMessage(assistant("two"));
			await manager.appendModelChange("test", "model");
			await manager.appendThinkingLevelChange("high");
			await manager.appendLabelChange(rootId, "checkpoint");
			await manager.appendSessionInfo("name");
			expect(manager.getEntries().length).toBeGreaterThanOrEqual(4);
			expect(manager.getLabel(rootId)).toBe("checkpoint");
			expect(manager.getSessionName()).toBe("name");
			expect(manager.buildSessionContext()).toMatchObject({
				thinkingLevel: "high",
				model: { provider: "test", modelId: "model" },
			});
			await manager.close();
			await manager.close();
		});

		it("supports branch navigation without exposing leaf records", async () => {
			const manager = await create();
			const rootId = await manager.appendMessage(user("one"));
			const abandoned = await manager.appendMessage(assistant("two"));
			await manager.branch(rootId);
			await manager.appendMessage(assistant("branched"));
			expect(manager.getBranch().map((entry) => entry.id)).not.toContain(abandoned);
			expect(manager.getEntries().some((entry) => (entry as { type: string }).type === "leaf")).toBe(false);
			await manager.close();
		});
	});
}

afterEach(() => {
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});
