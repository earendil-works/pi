import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

// Regression test for: SessionManager._persist crashing with ENOENT when the
// session directory is missing at write time (e.g. removed after the
// SessionManager was constructed, or never created for an explicit session
// file path). Previously this threw inside appendFileSync/openSync, which is
// especially harmful when _persist runs while the agent is already handling
// a failure (Agent.handleRunFailure -> ... -> SessionManager.appendMessage ->
// _appendEntry -> _persist): the ENOENT would replace/mask the original error
// and no session artifact would be produced at all.
describe("SessionManager._persist directory resilience", () => {
	let tempDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-persist-missing-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "workspace");
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function assistantMessage(text: string, timestamp: number) {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text }],
			api: "anthropic-messages" as const,
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
			stopReason: "stop" as const,
			timestamp,
		};
	}

	it("recreates a session directory removed after construction instead of throwing ENOENT", () => {
		const sessionDir = join(tempDir, ".pi", "sessions");
		const session = SessionManager.create(cwd, sessionDir);

		// Trigger the first flush (writes the file for the first time).
		session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		session.appendMessage(assistantMessage("hello", 2));

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile as string)).toBe(true);

		// Simulate the directory disappearing out from under the session, e.g.
		// a workspace reset or an errant `rm -rf` of .pi between writes.
		rmSync(sessionDir, { recursive: true, force: true });
		expect(existsSync(sessionDir)).toBe(false);

		// This previously threw: Error: ENOENT: no such file or directory, open ...
		expect(() =>
			session.appendMessage({ role: "user", content: "after directory removed", timestamp: 3 }),
		).not.toThrow();

		expect(existsSync(sessionFile as string)).toBe(true);
		const content = readFileSync(sessionFile as string, "utf8");
		expect(content).toContain("after directory removed");
	});

	it("creates the parent directory for an explicit session file whose parent differs from the tracked sessionDir", () => {
		// SessionManager.open(path, sessionDir) lets callers pass a sessionDir that
		// differs from the explicit file's own parent directory. The constructor
		// only ensures `sessionDir` exists, so the file's actual parent directory
		// can still be missing the first time `_persist` tries to write to it.
		const trackedSessionDir = join(tempDir, "tracked-dir");
		const explicitDir = join(tempDir, "explicit", "nested", "dir");
		const explicitFile = join(explicitDir, "custom-session.jsonl");
		expect(existsSync(explicitDir)).toBe(false);

		const session = SessionManager.open(explicitFile, trackedSessionDir);
		session.appendMessage({ role: "user", content: "hi", timestamp: 1 });

		// Previously threw: Error: ENOENT: no such file or directory, open ...
		expect(() => session.appendMessage(assistantMessage("hello", 2))).not.toThrow();

		expect(existsSync(explicitFile)).toBe(true);
	});
});
