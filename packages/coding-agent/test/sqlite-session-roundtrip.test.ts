import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSessionEntries, SessionManager } from "../src/core/session-manager.ts";
import { exportSqliteSessionToJsonl, importJsonlIntoSqlite } from "../src/core/sqlite-session-interchange.ts";
import { CodingAgentSqliteSessionRepository } from "../src/core/sqlite-session-repository.ts";

describe("SQLite JSONL interchange", () => {
	let root: string;
	let repository: CodingAgentSqliteSessionRepository;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-sqlite-roundtrip-"));
		repository = new CodingAgentSqliteSessionRepository(join(root, "sessions.sqlite"));
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("round-trips a JSONL session through SQLite", async () => {
		const source = SessionManager.create(root, root, { id: "roundtrip" });
		source.appendMessage({ role: "user", content: [{ type: "text", text: "one" }], timestamp: Date.now() });
		source.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "two" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
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
		});
		const imported = await importJsonlIntoSqlite({ repository, inputPath: source.getSessionFile()! });
		expect((await imported.buildContext()).messages.map((message) => message.role)).toEqual(["user", "assistant"]);

		const outputPath = join(root, "export", "session.jsonl");
		await exportSqliteSessionToJsonl({ session: imported, outputPath });
		const exported = parseSessionEntries(readFileSync(outputPath, "utf8"));
		expect(exported.map((entry) => entry.type)).toEqual(["session", "message", "message"]);
		const messages = exported.filter((entry) => entry.type === "message");
		expect(messages[0]?.parentId).toBeNull();
		expect(messages[1]?.parentId).toBe(messages[0]?.id);
		await imported.close();
	});

	it("removes a partially imported session on failure", async () => {
		const path = join(root, "invalid.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify({ type: "session", version: 3, id: "broken", timestamp: new Date().toISOString(), cwd: root })}\n${JSON.stringify({ type: "unknown", id: "bad", parentId: null, timestamp: new Date().toISOString() })}\n`,
		);
		await expect(importJsonlIntoSqlite({ repository, inputPath: path })).rejects.toThrow();
		expect(await repository.list()).toEqual([]);
	});

	it("rejects session id collisions without changing the existing session", async () => {
		const existing = await repository.create({ cwd: root, id: "duplicate" });
		await existing.appendSessionName("existing");
		await existing.close();
		const path = join(root, "duplicate.jsonl");
		writeFileSync(
			path,
			`${JSON.stringify({ type: "session", version: 3, id: "duplicate", timestamp: new Date().toISOString(), cwd: root })}\n`,
		);
		await expect(importJsonlIntoSqlite({ repository, inputPath: path })).rejects.toThrow();
		const reopened = await repository.openById("duplicate");
		expect(await reopened.getSessionName()).toBe("existing");
		await reopened.close();
	});
});
