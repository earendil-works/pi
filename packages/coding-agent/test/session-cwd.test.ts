import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { getMissingSessionCwdIssue, MissingSessionCwdError, updateSessionFileCwd } from "../src/core/session-cwd.ts";
import { loadEntriesFromFile, SessionManager } from "../src/core/session-manager.ts";

function createTempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeSessionFile(path: string, cwd: string): void {
	writeFileSync(
		path,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "session-id",
			timestamp: new Date().toISOString(),
			cwd,
		})}\n`,
	);
}

describe("session cwd handling", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		for (const path of cleanupPaths.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
	});

	it("detects missing session cwd from persisted sessions", () => {
		const fallbackCwd = createTempDir("pi-session-cwd-fallback");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		const sessionManager = SessionManager.open(sessionFile);
		const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
		expect(issue).toEqual({
			sessionFile: sessionManager.getSessionFile(),
			sessionCwd: missingCwd,
			fallbackCwd,
		});
	});

	it("supports overriding the effective cwd when opening a session", () => {
		const fallbackCwd = createTempDir("pi-session-cwd-override");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-override-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		const sessionManager = SessionManager.open(sessionFile, undefined, fallbackCwd);
		expect(sessionManager.getCwd()).toBe(fallbackCwd);
		expect(getMissingSessionCwdIssue(sessionManager, fallbackCwd)).toBeUndefined();
	});

	it("throws a controlled error before runtime creation when the stored cwd is missing", async () => {
		const fallbackCwd = createTempDir("pi-session-cwd-runtime");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-runtime-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		const sessionManager = SessionManager.open(sessionFile);
		let createRuntimeCalled = false;
		const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
			createRuntimeCalled = true;
			throw new Error("should not be called");
		};

		await expect(
			createAgentSessionRuntime(createRuntime, {
				cwd: fallbackCwd,
				agentDir: fallbackCwd,
				sessionManager,
			}),
		).rejects.toBeInstanceOf(MissingSessionCwdError);
		expect(createRuntimeCalled).toBe(false);
	});

	// #11060: once the user picks a folder for a moved session, later resumes must not ask again
	it("persists the chosen cwd in the session file header", () => {
		const fallbackCwd = createTempDir("pi-session-cwd-save");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-save-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		updateSessionFileCwd(sessionFile, fallbackCwd);

		const sessionManager = SessionManager.open(sessionFile);
		expect(sessionManager.getCwd()).toBe(fallbackCwd);
		expect(getMissingSessionCwdIssue(sessionManager, fallbackCwd)).toBeUndefined();
	});

	it("keeps leading non-header lines and later entries byte-identical", () => {
		const fallbackCwd = createTempDir("pi-session-cwd-entries");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-entries-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);

		const messageLine =
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}';
		writeFileSync(
			sessionFile,
			`junk line\n\n${JSON.stringify({
				type: "session",
				version: 3,
				id: "session-id",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: missingCwd,
			})}\n${messageLine}\n`,
		);

		updateSessionFileCwd(sessionFile, fallbackCwd);

		expect(readFileSync(sessionFile, "utf8")).toBe(
			`junk line\n\n${JSON.stringify({
				type: "session",
				version: 3,
				id: "session-id",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: fallbackCwd,
			})}\n${messageLine}\n`,
		);
		expect(loadEntriesFromFile(sessionFile)).toHaveLength(2);
	});

	it("rejects files whose first entry is not a session header", () => {
		const sessionDir = createTempDir("pi-session-cwd-invalid");
		const sessionFile = join(sessionDir, "not-a-session.jsonl");
		cleanupPaths.push(sessionDir);
		writeFileSync(sessionFile, '{"type":"message","id":"1"}\n');

		expect(() => updateSessionFileCwd(sessionFile, sessionDir)).toThrow("not a valid");
		expect(readFileSync(sessionFile, "utf8")).toBe('{"type":"message","id":"1"}\n');
		expect(existsSync(`${sessionFile}.${process.pid}.tmp`)).toBe(false);
	});
});
