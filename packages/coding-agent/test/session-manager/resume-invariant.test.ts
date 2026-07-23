import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { getDefaultSessionDir, SessionManager } from "../../src/core/session-manager.ts";

// Regression for: running /resume inside a session that was itself opened via /resume
// collapses the picker to a single self-reference (same-cwd sessions only).
//
// Root cause: SessionManager.open(path) derived `sessionDir` from the file's *parent*
// directory. After resuming a session whose stored `cwd` differs from the "native" cwd
// of the directory the file lives in (a project dir aggregating sessions from multiple
// cwds — git worktrees, a shared `--session-dir`, a relocated/renamed project), the
// post-resume (cwd, sessionDir) pair violates `sessionDir === getDefaultSessionDirPath(cwd)`.
// `list()`'s `filterCwd` heuristic (`dir !== getDefaultSessionDirPath(cwd)`) then arms and
// filters the picker down to same-cwd sessions — frequently just the resumed session itself.
//
// Fix: when no sessionDir is passed, `open()` defaults `sessionDir` to the cwd's own
// default session dir when that dir already exists, restoring the invariant. These tests
// pin that behavior and its fallback.

function createPersistedSessionInDir(dir: string, cwd: string): string {
	// SessionManager only flushes to disk once an assistant message is appended
	// (see _persist()), so mirror the real two-turn shape to materialize the file.
	const session = SessionManager.create(cwd, dir);
	session.appendMessage({ role: "user", content: `from ${cwd}`, timestamp: Date.now() });
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: `reply from ${cwd}` }],
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
	const sessionFile = session.getSessionFile();
	if (!sessionFile) {
		throw new Error("Expected persisted session file");
	}
	return sessionFile;
}

describe("SessionManager.open — sessionDir invariant after resume (regression)", () => {
	let agentDir: string;
	let aggregateDir: string;
	let savedAgentDir: string | undefined;
	let projectADefaultDir: string;
	const projectA = join(tmpdir(), `pi-resume-projA-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const projectB = join(tmpdir(), `pi-resume-projB-${Date.now()}-${Math.random().toString(36).slice(2)}`);

	beforeEach(() => {
		// Isolate the agent dir so getDefaultSessionDirPath() resolves under a temp tree,
		// never the real ~/.pi/agent.
		agentDir = mkdtempSync(join(tmpdir(), "pi-resume-agent-"));
		aggregateDir = mkdtempSync(join(tmpdir(), "pi-resume-agg-"));
		savedAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		// The fix keys off the cwd's DEFAULT session dir *existing*. Pre-create projectA's
		// (getDefaultSessionDir() mkdirs it) so the "exists" branch is taken.
		projectADefaultDir = getDefaultSessionDir(projectA);
	});

	afterEach(() => {
		if (savedAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = savedAgentDir;
		}
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(aggregateDir, { recursive: true, force: true });
	});

	it("resolves sessionDir to the cwd's default dir (not the file's parent) when it exists", () => {
		// An aggregate dir holds sessions from two different cwds — the git-worktree /
		// shared --session-dir shape.
		const fileA = createPersistedSessionInDir(aggregateDir, projectA);
		createPersistedSessionInDir(aggregateDir, projectB);

		// The aggregate dir is NOT projectA's default dir.
		expect(aggregateDir).not.toBe(projectADefaultDir);

		// Resuming sessionA: its file lives in the aggregate dir, its cwd is projectA, and
		// projectA's default dir exists. The fix must resolve sessionDir to projectA's
		// default dir, restoring usesDefaultSessionDir() (which gates BOTH the picker cwd
		// filter and the "All" scope in showSessionSelector).
		const mgr = SessionManager.open(fileA);
		expect(mgr.usesDefaultSessionDir()).toBe(true);
		expect(mgr.getSessionDir()).toBe(projectADefaultDir);
	});

	it("does not collapse the /resume picker to same-cwd sessions after a resume", async () => {
		// projectA's default dir holds a prior projectA-cwd session (the rest of the
		// project history a fresh-launch /resume would show).
		const inDefault = createPersistedSessionInDir(projectADefaultDir, projectA);
		// The aggregate dir holds a projectA-cwd session and an unrelated projectB session.
		const fileA = createPersistedSessionInDir(aggregateDir, projectA);
		createPersistedSessionInDir(aggregateDir, projectB);

		// Simulate the in-session /resume picker AFTER resuming sessionA.
		const mgr = SessionManager.open(fileA);
		const listed = await SessionManager.list(mgr.getCwd(), mgr.getSessionDir());

		// With the fix, mgr.getSessionDir() === projectA's default dir, so list() does NOT
		// arm the cwd filter and returns the project's default-dir contents (incl. the
		// prior session) — NOT a single self-reference to the just-resumed session.
		expect(listed.map((s) => s.path)).toContain(inDefault);
		expect(listed.map((s) => s.path)).not.toContain(fileA);
	});

	it("falls back to the file's parent dir when the cwd's default dir does not exist", () => {
		// projectC's default dir is never created — the existsSync guard must fall back to
		// the parent dir, preserving prior behavior (no stray dir creation, no change for
		// ad-hoc paths / projects with no session history).
		const projectC = join(tmpdir(), `pi-resume-projC-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const fileC = createPersistedSessionInDir(aggregateDir, projectC);
		const mgr = SessionManager.open(fileC);
		expect(mgr.getSessionDir()).toBe(aggregateDir);
		expect(mgr.usesDefaultSessionDir()).toBe(false);
	});
});
