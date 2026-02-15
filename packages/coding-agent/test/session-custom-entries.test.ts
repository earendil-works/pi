import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionManager } from "../src/session-manager.js";

describe("SessionManager custom entries", () => {
	let dir: string;
	let prev: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mu-session-custom-"));
		prev = process.cwd();
		process.chdir(dir);
	});

	afterEach(() => {
		process.chdir(prev);
		rmSync(dir, { recursive: true, force: true });
	});

	it("loadMessages includes custom_message entries", () => {
		const sessionFile = join(dir, "session.jsonl");
		const mgr = new SessionManager(false, sessionFile, false, dir);
		mgr.startSession({ model: { provider: "test", id: "test" }, thinkingLevel: "off", messages: [] } as never);

		const msg1: Message = { role: "user", content: "hello", timestamp: Date.now() };
		mgr.saveMessage(msg1);

		mgr.appendCustomMessage("internal", { role: "user", content: "hidden", timestamp: Date.now() });

		const loaded = mgr.loadMessages();
		expect(loaded.length).toBe(2);
		expect(loaded[0]?.role).toBe("user");
		expect(loaded[1]?.content).toBe("hidden");
	});

	it("createBranchedSession copies custom entries and custom_message up to message index", () => {
		const sessionFile = join(dir, "session.jsonl");
		const mgr = new SessionManager(false, sessionFile, false, dir);
		mgr.startSession({ model: { provider: "test", id: "test" }, thinkingLevel: "off", messages: [] } as never);

		mgr.saveMessage({ role: "user", content: "m1", timestamp: Date.now() });
		mgr.appendCustomEntry("note", { a: 1 });
		mgr.appendCustomMessage("internal", { role: "user", content: "cm1", timestamp: Date.now() });
		mgr.saveMessage({
			role: "assistant",
			content: [{ type: "text", text: "m2" }],
			api: "openai-completions",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		mgr.appendCustomEntry("note", { a: 2 });

		const newFile = mgr.createBranchedSession(
			{ model: { provider: "test", id: "test" }, thinkingLevel: "off", messages: [] } as never,
			1,
		);

		const lines = readFileSync(newFile, "utf8").trim().split("\n");
		// Expect: header + m1 + custom(note a:1) + custom_message(cm1)
		expect(lines.some((l) => l.includes('"type":"custom"') && l.includes('"a":1'))).toBe(true);
		expect(lines.some((l) => l.includes('"type":"custom_message"') && l.includes('"cm1"'))).toBe(true);
		// Should NOT include m2 or note a:2
		expect(lines.some((l) => l.includes('"m2"'))).toBe(false);
		expect(lines.some((l) => l.includes('"a":2'))).toBe(false);
	});
});
