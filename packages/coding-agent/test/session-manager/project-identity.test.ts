import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * Regression fixtures for cross-worktree project identity (the
 * "Session found in different project → Fork this session into current
 * directory?" prompt when resuming a worktree-born session from another
 * checkout of the SAME repository):
 *
 *  a) session born in worktree W, listed/resumed from the main checkout (or a
 *     sibling worktree) with NO --session-dir → must match LOCALLY (same git
 *     repository ⇒ same project).
 *  b) same session listed with a SYMLINK ALIAS of the default session dir
 *     (same inode, different path string) as --session-dir → must NOT arm the
 *     cwd filter (symlink-resolved comparison) and must NOT demote to global.
 */

describe("SessionManager project identity", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-identity-"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Build a fake repository layout: main checkout + linked worktrees sharing one common git dir. */
	function createRepoWithWorktrees(): { mainRepo: string; worktreeA: string; worktreeB: string; otherRepo: string } {
		const mainRepo = join(tempDir, "repo");
		const commonGit = join(mainRepo, ".git");
		mkdirSync(join(commonGit, "worktrees", "wt-a"), { recursive: true });
		mkdirSync(join(commonGit, "worktrees", "wt-b"), { recursive: true });

		const worktreeA = join(tempDir, "wt-a");
		const worktreeB = join(tempDir, "wt-b");
		mkdirSync(worktreeA, { recursive: true });
		mkdirSync(worktreeB, { recursive: true });
		writeFileSync(join(worktreeA, ".git"), `gitdir: ${join(commonGit, "worktrees", "wt-a")}\n`);
		writeFileSync(join(worktreeB, ".git"), `gitdir: ${join(commonGit, "worktrees", "wt-b")}\n`);

		// An unrelated repository sharing nothing with the first.
		const otherRepo = join(tempDir, "other-repo");
		mkdirSync(join(otherRepo, ".git"), { recursive: true });

		return { mainRepo, worktreeA, worktreeB, otherRepo };
	}

	function writeSessionFile(sessionDir: string, id: string, cwd: string): string {
		mkdirSync(sessionDir, { recursive: true });
		const file = join(sessionDir, `2026-09-18T00-00-00-000Z_${id}.jsonl`);
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 1, id, timestamp: "2026-09-18T00:00:00.000Z", cwd })}\n`,
		);
		return file;
	}

	it("fixture (a): a session born in a worktree is a LOCAL match from the main checkout and sibling worktrees", async () => {
		const { mainRepo, worktreeA, worktreeB } = createRepoWithWorktrees();
		// The store used by every checkout of this repo (mirrors launchers that
		// unify worktree session dirs onto one shared directory).
		const store = join(tempDir, "shared-store");
		writeSessionFile(store, "aaaaaaaa-1111-2222-3333-444444444444", worktreeA);

		// From the main checkout, no custom session dir: the worktree-born
		// session must list (same repository ⇒ same project).
		const fromMain = await SessionManager.list(mainRepo, store);
		expect(fromMain.map((s) => s.id)).toContain("aaaaaaaa-1111-2222-3333-444444444444");

		// From the sibling worktree B with the shared store as a custom dir the
		// cwd filter arms — and repo-root matching must keep the session local.
		const fromWorktreeB = await SessionManager.list(worktreeB, store);
		expect(fromWorktreeB.map((s) => s.id)).toContain("aaaaaaaa-1111-2222-3333-444444444444");

		// findMostRecentSession (the --continue path) picks it up too.
		const { findMostRecentSession } = await import("../../src/core/session-manager.ts");
		expect(findMostRecentSession(store, worktreeB)).toBeTruthy();
	});

	it("fixture (b): a symlink ALIAS of the default session dir does not arm the cwd filter or demote to global", async () => {
		const agentDir = join(tempDir, "agent-home");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

		const { worktreeA } = createRepoWithWorktrees();
		// The canonical checkout: a THIRD clone of the same repository layout —
		// model it as another worktree of the same common git dir.
		const commonGit = join(tempDir, "repo", ".git");
		const canonical = join(tempDir, "canonical");
		mkdirSync(join(canonical, "sub"), { recursive: true });
		mkdirSync(join(commonGit, "worktrees", "canonical"), { recursive: true });
		writeFileSync(join(canonical, ".git"), `gitdir: ${join(commonGit, "worktrees", "canonical")}\n`);

		// The default session dir for the canonical cwd, plus the worktree ALIAS
		// symlinked to it (same inode, different path string — the launcher
		// pattern that produced the fork prompt).
		const canonicalCwd = join(canonical, "sub");
		mkdirSync(canonicalCwd, { recursive: true });
		const defaultManager = await SessionManager.list(canonicalCwd); // creates the default dir
		expect(defaultManager).toEqual([]);

		const defaultDir = join(
			agentDir,
			"sessions",
			`--${canonicalCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
		);
		const aliasDir = join(agentDir, "sessions", `--alias-of-default--`);
		symlinkSync(defaultDir, aliasDir);

		// Session born in worktree A, stored in the canonical (default) store.
		writeSessionFile(defaultDir, "bbbbbbbb-1111-2222-3333-444444444444", worktreeA);

		// Resuming from the canonical checkout THROUGH the alias: the alias is
		// the same directory as the default dir, so the cwd filter must stay
		// disarmed and the session must remain a local match (no global demote,
		// no fork offer).
		const viaAlias = await SessionManager.list(canonicalCwd, aliasDir);
		expect(viaAlias.map((s) => s.id)).toContain("bbbbbbbb-1111-2222-3333-444444444444");

		// And without the alias at all (the paved operator path): silent local match.
		const viaDefault = await SessionManager.list(canonicalCwd);
		expect(viaDefault.map((s) => s.id)).toContain("bbbbbbbb-1111-2222-3333-444444444444");
	});

	it("usesDefaultSessionDir() is true for a symlink alias of the default dir", async () => {
		const agentDir = join(tempDir, "agent-home");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);

		const project = join(tempDir, "plain-project");
		mkdirSync(project, { recursive: true });
		await SessionManager.list(project); // creates the default dir

		const defaultDir = join(agentDir, "sessions", `--${project.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
		const aliasDir = join(agentDir, "sessions", `--plain-alias--`);
		symlinkSync(defaultDir, aliasDir);

		const sessionFile = join(defaultDir, "2026-09-18T00-00-00-000Z_cccccccc-1111-2222-3333-444444444444.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 1, id: "cccccccc-1111-2222-3333-444444444444", timestamp: "2026-09-18T00:00:00.000Z", cwd: project })}\n`,
		);

		const manager = SessionManager.open(sessionFile, aliasDir);
		expect(manager.usesDefaultSessionDir()).toBe(true);
	});

	it("negative: a session from a DIFFERENT repository does not match when the cwd filter is armed", async () => {
		const { worktreeA, otherRepo } = createRepoWithWorktrees();
		const store = join(tempDir, "aggregate-store");
		writeSessionFile(store, "dddddddd-1111-2222-3333-444444444444", worktreeA);

		// Genuinely-custom aggregate dir: the filter arms and the other-repo cwd
		// must NOT see repo A's session (the flat-aggregate contract).
		const fromOther = await SessionManager.list(otherRepo, store);
		expect(fromOther.map((s) => s.id)).not.toContain("dddddddd-1111-2222-3333-444444444444");

		// The same-repo cwd still sees it.
		const fromWorktree = await SessionManager.list(worktreeA, store);
		expect(fromWorktree.map((s) => s.id)).toContain("dddddddd-1111-2222-3333-444444444444");
	});

	it("relative worktree gitdir pointers resolve against the .git file's directory", async () => {
		// git writes absolute pointers, but a RELATIVE pointer (`gitdir: ../repo/.git/...`)
		// must still resolve to the same common dir as the main checkout.
		const { mainRepo, worktreeB } = createRepoWithWorktrees();
		const worktreeRel = join(tempDir, "wt-rel");
		mkdirSync(worktreeRel, { recursive: true });
		writeFileSync(join(worktreeRel, ".git"), "gitdir: ../repo/.git/worktrees/wt-b\n");

		const store = join(tempDir, "shared-store-2");
		writeSessionFile(store, "eeeeeeee-1111-2222-3333-444444444444", worktreeRel);

		const fromMain = await SessionManager.list(mainRepo, store);
		expect(fromMain.map((s) => s.id)).toContain("eeeeeeee-1111-2222-3333-444444444444");

		// Sanity: the sibling worktree (absolute pointer) matches the relative one.
		const fromWorktreeB = await SessionManager.list(worktreeB, store);
		expect(fromWorktreeB.map((s) => s.id)).toContain("eeeeeeee-1111-2222-3333-444444444444");
	});

	it("fixture (a) header cwd is read from the session file, not the listing cwd", () => {
		const { worktreeA } = createRepoWithWorktrees();
		const store = join(tempDir, "store");
		const file = writeSessionFile(store, "ffffffff-1111-2222-3333-444444444444", worktreeA);
		// The header must carry the BIRTH cwd so an in-place resume binds to it.
		const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]);
		expect(header.cwd).toBe(worktreeA);
		expect(dirname(file)).toBe(store);
	});
});
