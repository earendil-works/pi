/**
 * Tests for git-based extension updates, specifically handling force-push scenarios.
 *
 * These tests verify that DefaultPackageManager.update() handles:
 * - Normal git updates (no force-push)
 * - Force-pushed remotes gracefully (currently fails, fix needed)
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

// Helper to run git commands in a directory
function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
	});
	if (result.status !== 0) {
		throw new Error(`Command failed: git ${args.join(" ")}\n${result.stderr}`);
	}
	return result.stdout.trim();
}

function initGitRepo(repoDir: string): void {
	git(["init", "--initial-branch=main"], repoDir);
	git(["config", "--local", "user.email", "test@test.com"], repoDir);
	git(["config", "--local", "user.name", "Test"], repoDir);
}

// Helper to create a commit with a file
function createCommit(repoDir: string, filename: string, content: string, message: string): string {
	writeFileSync(join(repoDir, filename), content);
	git(["add", filename], repoDir);
	git(["commit", "-m", message], repoDir);
	return git(["rev-parse", "HEAD"], repoDir);
}

// Helper to get current commit hash
function getCurrentCommit(repoDir: string): string {
	return git(["rev-parse", "HEAD"], repoDir);
}

// Helper to get file content
function getFileContent(repoDir: string, filename: string): string {
	return readFileSync(join(repoDir, filename), "utf-8");
}

describe("DefaultPackageManager git update", () => {
	let tempDir: string;
	let remoteDir: string; // Simulates the "remote" repository
	let agentDir: string; // The agent directory where extensions are installed
	let installedDir: string; // The installed extension directory
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	// Git source that maps to our installed directory structure.
	// Must use "git:" prefix so parseSource() treats it as a git source
	// (bare "github.com/..." is not recognized as a git URL).
	const gitSource = "git:github.com/test/extension";

	beforeEach(() => {
		tempDir = join(tmpdir(), `git-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		remoteDir = join(tempDir, "remote");
		agentDir = join(tempDir, "agent");

		// This matches the path structure: agentDir/git/<host>/<path>
		installedDir = join(agentDir, "git", "github.com", "test", "extension");

		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	/**
	 * Sets up a "remote" repository and clones it to the installed directory.
	 * This simulates what packageManager.install() would do.
	 * @param sourceOverride Optional source string to use instead of gitSource (e.g., with @ref for pinned tests)
	 */
	function setupRemoteAndInstall(sourceOverride?: string): void {
		// Create "remote" repository
		mkdirSync(remoteDir, { recursive: true });
		initGitRepo(remoteDir);
		createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");

		// Clone to installed directory (simulating what install() does)
		mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
		git(["clone", remoteDir, installedDir], tempDir);
		git(["config", "--local", "user.email", "test@test.com"], installedDir);
		git(["config", "--local", "user.name", "Test"], installedDir);

		// Add to global packages so update() processes this source
		settingsManager.setPackages([sourceOverride ?? gitSource]);
	}

	describe("normal updates (no force-push)", () => {
		it("should skip reset, clean, and install when already up to date", async () => {
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			writeFileSync(join(remoteDir, "package.json"), JSON.stringify({ name: "test-extension", version: "1.0.0" }));
			createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			settingsManager.setPackages([gitSource]);

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
			};
			managerWithInternals.runCommand = async (command, args, options) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				if (command === "npm") {
					return;
				}
				const result = spawnSync(command, args, {
					cwd: options?.cwd,
					encoding: "utf-8",
				});
				if (result.status !== 0) {
					throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
				}
			};

			await packageManager.update();

			expect(executedCommands).toContain(
				"git fetch --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main",
			);
			expect(executedCommands).not.toContain("git fetch --prune origin");
			expect(executedCommands).not.toContain("git reset --hard @{upstream}");
			expect(executedCommands).not.toContain("git reset --hard origin/HEAD");
			expect(executedCommands).not.toContain("git clean -fdx");
			expect(executedCommands).not.toContain("npm install");
		});

		it("should update to latest commit when remote has new commits", async () => {
			setupRemoteAndInstall();
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");

			// Add a new commit to remote
			const newCommit = createCommit(remoteDir, "extension.ts", "// v2", "Second commit");

			// Update via package manager (no args = uses settings)
			await packageManager.update();

			// Verify update succeeded
			expect(getCurrentCommit(installedDir)).toBe(newCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");
		});

		it("should handle multiple commits ahead", async () => {
			setupRemoteAndInstall();

			// Add multiple commits to remote
			createCommit(remoteDir, "extension.ts", "// v2", "Second commit");
			createCommit(remoteDir, "extension.ts", "// v3", "Third commit");
			const latestCommit = createCommit(remoteDir, "extension.ts", "// v4", "Fourth commit");

			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(latestCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v4");
		});

		it("should update even when local checkout has no upstream", async () => {
			setupRemoteAndInstall();
			createCommit(remoteDir, "extension.ts", "// v2", "Second commit");
			const latestCommit = createCommit(remoteDir, "extension.ts", "// v3", "Third commit");

			const detachedCommit = getCurrentCommit(installedDir);
			git(["checkout", detachedCommit], installedDir);

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
			};
			managerWithInternals.runCommand = async (command, args, options) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				const result = spawnSync(command, args, {
					cwd: options?.cwd,
					encoding: "utf-8",
				});
				if (result.status !== 0) {
					throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
				}
			};

			await packageManager.update();

			expect(executedCommands).toContain(
				"git fetch --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main",
			);
			expect(getCurrentCommit(installedDir)).toBe(latestCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v3");
		});
	});

	describe("no-ref reconciliation tracks remote default", () => {
		// Regression coverage for the case where a user previously installed a
		// branch ref (`git:host/user/repo@feat/x`), then removed the ref from
		// settings.json. The local clone retains its @{upstream} pointing at
		// `origin/feat/x`, and the prior implementation of
		// `getLocalGitUpdateTarget` honored that upstream forever, so the clone
		// would never move back to the remote default branch even though the
		// user's expressed intent is now "track default".

		it("should issue fetch for the default branch ref, not the locally tracked feature branch", async () => {
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");
			git(["checkout", "-b", "feature"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// feature", "Feature work");
			git(["checkout", "main"], remoteDir);
			const mainTip = createCommit(remoteDir, "extension.ts", "// v2", "Mainline progress");

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			git(["config", "--local", "user.email", "test@test.com"], installedDir);
			git(["config", "--local", "user.name", "Test"], installedDir);
			git(["checkout", "feature"], installedDir);
			settingsManager.setPackages([gitSource]);

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
				runCommandCapture: (
					command: string,
					args: string[],
					options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
				) => Promise<string>;
			};
			const originalCapture = managerWithInternals.runCommandCapture.bind(packageManager);
			managerWithInternals.runCommandCapture = async (command, args, options) => {
				if (command === "git" && args[0] === "remote" && args[1] === "set-head") {
					executedCommands.push(`${command} ${args.join(" ")}`);
					expect(options?.env?.GIT_TERMINAL_PROMPT).toBe("0");
				}
				return originalCapture(command, args, options);
			};
			managerWithInternals.runCommand = async (command, args, options) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				if (command === "npm") {
					return;
				}
				const result = spawnSync(command, args, {
					cwd: options?.cwd,
					encoding: "utf-8",
				});
				if (result.status !== 0) {
					throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
				}
			};

			await packageManager.update();

			// Pin both: the fetch refspec (asked for main, not feature) and
			// the resulting HEAD/file (clone moved off feature). A hybrid bug
			// (right HEAD via wrong fetch, or right fetch with skipped reset)
			// must fail at least one assertion.
			expect(executedCommands).toContain(
				"git fetch --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main",
			);
			expect(executedCommands).not.toContain(
				"git fetch --prune --no-tags origin +refs/heads/feature:refs/remotes/origin/feature",
			);
			// Pin that we re-resolve the remote default branch before fetching
			// so a stale local origin/HEAD symbolic-ref does not steer the fetch.
			expect(executedCommands).toContain("git remote set-head origin -a");
			expect(getCurrentCommit(installedDir)).toBe(mainTip);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");
		});

		it("should still reconcile when remote set-head fails (e.g. transient network)", async () => {
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");
			git(["checkout", "-b", "feature"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// feature", "Feature work");
			git(["checkout", "main"], remoteDir);
			const mainTip = createCommit(remoteDir, "extension.ts", "// v2", "Mainline progress");

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			git(["config", "--local", "user.email", "test@test.com"], installedDir);
			git(["config", "--local", "user.name", "Test"], installedDir);
			git(["checkout", "feature"], installedDir);
			settingsManager.setPackages([gitSource]);

			// Make `git remote set-head origin -a` throw (simulating a network
			// failure during the re-resolve attempt). The cached origin/HEAD
			// symbolic-ref already points at main from `git clone`, so
			// reconciliation must still complete via the cached value.
			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
				runCommandCapture: (
					command: string,
					args: string[],
					options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
				) => Promise<string>;
			};
			const originalCapture = managerWithInternals.runCommandCapture.bind(packageManager);
			managerWithInternals.runCommandCapture = async (command, args, options) => {
				if (command === "git" && args[0] === "remote" && args[1] === "set-head") {
					executedCommands.push(`${command} ${args.join(" ")}`);
					throw new Error("simulated network failure");
				}
				return originalCapture(command, args, options);
			};
			managerWithInternals.runCommand = async (command, args, options) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				if (command === "npm") {
					return;
				}
				const result = spawnSync(command, args, {
					cwd: options?.cwd,
					encoding: "utf-8",
				});
				if (result.status !== 0) {
					throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
				}
			};

			await packageManager.update();

			expect(executedCommands).toContain("git remote set-head origin -a");
			expect(getCurrentCommit(installedDir)).toBe(mainTip);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");
		});

		it("should fail loud when set-head fails AND origin/HEAD is uncached", async () => {
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");
			git(["checkout", "-b", "feature"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// feature", "Feature work");
			git(["checkout", "main"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// v2", "Mainline progress");

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			git(["config", "--local", "user.email", "test@test.com"], installedDir);
			git(["config", "--local", "user.name", "Test"], installedDir);
			git(["checkout", "feature"], installedDir);

			// Delete the cached `refs/remotes/origin/HEAD` symbolic-ref to
			// simulate a clone that doesn't have origin/HEAD populated. Stub
			// `git remote set-head origin -a` to throw, so reconciliation cannot
			// repopulate it. The function must surface the resulting
			// `rev-parse origin/HEAD` failure rather than silently skip the
			// reset.
			git(["symbolic-ref", "-d", "refs/remotes/origin/HEAD"], installedDir);
			settingsManager.setPackages([gitSource]);

			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
				runCommandCapture: (
					command: string,
					args: string[],
					options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
				) => Promise<string>;
			};
			const originalCapture = managerWithInternals.runCommandCapture.bind(packageManager);
			managerWithInternals.runCommandCapture = async (command, args, options) => {
				if (command === "git" && args[0] === "remote" && args[1] === "set-head") {
					throw new Error("simulated: network unreachable");
				}
				return originalCapture(command, args, options);
			};

			await expect(packageManager.update()).rejects.toThrow(/origin\/HEAD/);
		});

		it("should fall back to +HEAD:refs/remotes/origin/HEAD when symbolic-ref is empty", async () => {
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");
			git(["checkout", "-b", "feature"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// feature", "Feature work");
			git(["checkout", "main"], remoteDir);
			const mainTip = createCommit(remoteDir, "extension.ts", "// v2", "Mainline progress");

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			git(["config", "--local", "user.email", "test@test.com"], installedDir);
			git(["config", "--local", "user.name", "Test"], installedDir);
			git(["checkout", "feature"], installedDir);
			settingsManager.setPackages([gitSource]);

			// Stub `symbolic-ref refs/remotes/origin/HEAD` to return "" (covering
			// the `.catch(() => "")` fallback in `getLocalGitUpdateTarget`).
			// Production reaches this branch when symbolic-ref errors — e.g.,
			// when `origin/HEAD` is a regular (non-symbolic) ref. Other captured
			// commands pass through to spawnSync so the rest of the flow is real.
			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
				runCommandCapture: (
					command: string,
					args: string[],
					options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
				) => Promise<string>;
			};
			const originalCapture = managerWithInternals.runCommandCapture.bind(packageManager);
			managerWithInternals.runCommandCapture = async (command, args, options) => {
				if (command === "git" && args[0] === "symbolic-ref" && args[1] === "refs/remotes/origin/HEAD") {
					return "";
				}
				return originalCapture(command, args, options);
			};
			managerWithInternals.runCommand = async (command, args, options) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				if (command === "npm") {
					return;
				}
				const result = spawnSync(command, args, {
					cwd: options?.cwd,
					encoding: "utf-8",
				});
				if (result.status !== 0) {
					throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
				}
			};

			await packageManager.update();

			expect(executedCommands).toContain("git fetch --prune --no-tags origin +HEAD:refs/remotes/origin/HEAD");
			expect(executedCommands).not.toContain(
				"git fetch --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main",
			);
			expect(getCurrentCommit(installedDir)).toBe(mainTip);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");
		});

		it("should fall back to +HEAD when symbolic-ref points outside refs/remotes/origin/", async () => {
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");
			git(["checkout", "-b", "feature"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// feature", "Feature work");
			git(["checkout", "main"], remoteDir);
			const mainTip = createCommit(remoteDir, "extension.ts", "// v2", "Mainline progress");

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			git(["config", "--local", "user.email", "test@test.com"], installedDir);
			git(["config", "--local", "user.name", "Test"], installedDir);
			git(["checkout", "feature"], installedDir);
			settingsManager.setPackages([gitSource]);

			// Stub `symbolic-ref refs/remotes/origin/HEAD` to return a ref outside
			// `refs/remotes/origin/` (a user who manually re-targeted the
			// symbolic-ref to another remote). The parser must treat this as
			// "no usable branch" rather than emit a malformed fetch refspec.
			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
				runCommandCapture: (
					command: string,
					args: string[],
					options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
				) => Promise<string>;
			};
			const originalCapture = managerWithInternals.runCommandCapture.bind(packageManager);
			managerWithInternals.runCommandCapture = async (command, args, options) => {
				if (command === "git" && args[0] === "symbolic-ref" && args[1] === "refs/remotes/origin/HEAD") {
					return "refs/remotes/upstream/main";
				}
				return originalCapture(command, args, options);
			};
			managerWithInternals.runCommand = async (command, args, options) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				if (command === "npm") {
					return;
				}
				const result = spawnSync(command, args, {
					cwd: options?.cwd,
					encoding: "utf-8",
				});
				if (result.status !== 0) {
					throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
				}
			};

			await packageManager.update();

			expect(executedCommands).toContain("git fetch --prune --no-tags origin +HEAD:refs/remotes/origin/HEAD");
			expect(executedCommands).not.toContain(
				"git fetch --prune --no-tags origin +refs/heads/refs/remotes/upstream/main:refs/remotes/origin/refs/remotes/upstream/main",
			);
			expect(getCurrentCommit(installedDir)).toBe(mainTip);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");
		});

		it("install should reconcile no-ref source on existing clones", async () => {
			// Pre-clone exercises installGit's existing-clone branch (mirrors updateGit).
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");
			git(["checkout", "-b", "feature"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// feature", "Feature work");
			git(["checkout", "main"], remoteDir);
			const mainTip = createCommit(remoteDir, "extension.ts", "// v2", "Mainline progress");

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			git(["config", "--local", "user.email", "test@test.com"], installedDir);
			git(["config", "--local", "user.name", "Test"], installedDir);
			git(["checkout", "feature"], installedDir);

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
				runCommandCapture: (
					command: string,
					args: string[],
					options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
				) => Promise<string>;
			};
			const originalCapture = managerWithInternals.runCommandCapture.bind(packageManager);
			managerWithInternals.runCommandCapture = async (command, args, options) => {
				if (command === "git" && args[0] === "remote" && args[1] === "set-head") {
					executedCommands.push(`${command} ${args.join(" ")}`);
				}
				return originalCapture(command, args, options);
			};
			managerWithInternals.runCommand = async (command, args, options) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				if (command === "npm") {
					return;
				}
				const result = spawnSync(command, args, {
					cwd: options?.cwd,
					encoding: "utf-8",
				});
				if (result.status !== 0) {
					throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
				}
			};

			// Install path — not update.
			await packageManager.install(gitSource);

			// Pin the reconciliation shape: install must run set-head before
			// fetching, fetch the default branch (main) not the locally checked
			// out feature branch, and land on the main tip with main's content.
			expect(executedCommands).toContain("git remote set-head origin -a");
			expect(executedCommands).toContain(
				"git fetch --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main",
			);
			expect(getCurrentCommit(installedDir)).toBe(mainTip);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");
		});
	});

	describe("force-push scenarios", () => {
		it("should recover when remote history is rewritten", async () => {
			setupRemoteAndInstall();
			const initialCommit = getCurrentCommit(remoteDir);

			// Add commit to remote
			createCommit(remoteDir, "extension.ts", "// v2", "Commit to keep");

			// Update to get the new commit
			await packageManager.update();
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");

			// Now force-push to rewrite history on remote
			git(["reset", "--hard", initialCommit], remoteDir);
			const rewrittenCommit = createCommit(remoteDir, "extension.ts", "// v2-rewritten", "Rewritten commit");

			// Update should succeed despite force-push
			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(rewrittenCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2-rewritten");
		});

		it("should recover when local commit no longer exists in remote", async () => {
			setupRemoteAndInstall();

			// Add commits to remote
			createCommit(remoteDir, "extension.ts", "// v2", "Commit A");
			createCommit(remoteDir, "extension.ts", "// v3", "Commit B");

			// Update to get all commits
			await packageManager.update();
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v3");

			// Force-push remote to remove commits A and B
			git(["reset", "--hard", "HEAD~2"], remoteDir);
			const newCommit = createCommit(remoteDir, "extension.ts", "// v2-new", "New commit replacing A and B");

			// Update should succeed - the commits we had locally no longer exist
			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(newCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2-new");
		});

		it("should handle complete history rewrite", async () => {
			setupRemoteAndInstall();

			// Remote gets several commits
			createCommit(remoteDir, "extension.ts", "// v2", "v2");
			createCommit(remoteDir, "extension.ts", "// v3", "v3");

			await packageManager.update();
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v3");

			// Maintainer force-pushes completely different history
			git(["reset", "--hard", "HEAD~2"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// rewrite-a", "Rewrite A");
			const finalCommit = createCommit(remoteDir, "extension.ts", "// rewrite-b", "Rewrite B");

			// Should handle this gracefully
			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(finalCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// rewrite-b");
		});
	});

	describe("pinned sources", () => {
		it("should not move pinned git sources past their configured ref", async () => {
			// Create remote repo first to get the initial commit
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			const initialCommit = createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");

			// Install with pinned ref from the start - full clone to ensure commit is available
			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			git(["checkout", initialCommit], installedDir);
			git(["config", "--local", "user.email", "test@test.com"], installedDir);
			git(["config", "--local", "user.name", "Test"], installedDir);

			// Add to global packages with pinned ref
			settingsManager.setPackages([`${gitSource}@${initialCommit}`]);

			// Add new commit to remote
			createCommit(remoteDir, "extension.ts", "// v2", "Second commit");

			await packageManager.update();

			// Should still be on initial commit
			expect(getCurrentCommit(installedDir)).toBe(initialCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
		});

		it("should checkout the configured pinned git ref during full and targeted updates", async () => {
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			const v1Commit = createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");
			git(["tag", "v1"], remoteDir);
			const v2Commit = createCommit(remoteDir, "extension.ts", "// v2", "Second commit");
			git(["tag", "v2"], remoteDir);

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			git(["checkout", "v1"], installedDir);
			expect(getCurrentCommit(installedDir)).toBe(v1Commit);

			const pinnedSource = `${gitSource}@v2`;
			settingsManager.setPackages([pinnedSource]);

			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(v2Commit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");

			git(["checkout", "v1"], installedDir);

			await packageManager.update(pinnedSource);

			expect(getCurrentCommit(installedDir)).toBe(v2Commit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");
		});

		it("should not reset an annotated tag checkout that already matches the configured ref", async () => {
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			const taggedCommit = createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");
			git(["tag", "-a", "v1", "-m", "v1"], remoteDir);

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			git(["checkout", "v1"], installedDir);
			expect(getCurrentCommit(installedDir)).toBe(taggedCommit);

			settingsManager.setPackages([`${gitSource}@v1`]);

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
			};
			managerWithInternals.runCommand = async (command, args, options) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				const result = spawnSync(command, args, {
					cwd: options?.cwd,
					encoding: "utf-8",
				});
				if (result.status !== 0) {
					throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stderr}`);
				}
			};

			await packageManager.update();

			expect(executedCommands).toContain("git fetch origin v1");
			expect(executedCommands.some((command) => command.startsWith("git reset --hard"))).toBe(false);
			expect(executedCommands).not.toContain("git clean -fdx");
			expect(getCurrentCommit(installedDir)).toBe(taggedCommit);
		});
	});

	describe("temporary git sources", () => {
		it("should refresh cached temporary git sources when resolving", async () => {
			const gitHost = "github.com";
			const gitPath = "test/extension";
			const hash = createHash("sha256").update(`git-${gitHost}-${gitPath}`).digest("hex").slice(0, 8);
			const cachedDir = join(tmpdir(), "pi-extensions", `git-${gitHost}`, hash, gitPath);
			const extensionFile = join(cachedDir, "pi-extensions", "session-breakdown.ts");

			rmSync(cachedDir, { recursive: true, force: true });
			mkdirSync(join(cachedDir, "pi-extensions"), { recursive: true });
			writeFileSync(
				join(cachedDir, "package.json"),
				JSON.stringify({ pi: { extensions: ["./pi-extensions"] } }, null, 2),
			);
			writeFileSync(extensionFile, "// stale");

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
				runCommandCapture: (command: string, args: string[], options?: { cwd?: string }) => Promise<string>;
			};
			managerWithInternals.runCommand = async (command, args) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				if (command === "git" && args[0] === "reset") {
					writeFileSync(extensionFile, "// fresh");
				}
			};
			managerWithInternals.runCommandCapture = async (_command, args) => {
				if (args[0] === "rev-parse" && args[1] === "HEAD") {
					return "local-head";
				}
				if (args[0] === "rev-parse" && (args[1] === "origin/HEAD" || args[1] === "origin/HEAD^{commit}")) {
					return "remote-head";
				}
				if (args[0] === "symbolic-ref" && args[1] === "refs/remotes/origin/HEAD") {
					return "refs/remotes/origin/main";
				}
				return "";
			};

			await packageManager.resolveExtensionSources([gitSource], { temporary: true });

			expect(executedCommands).toContain(
				"git fetch --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main",
			);
			expect(getFileContent(cachedDir, "pi-extensions/session-breakdown.ts")).toBe("// fresh");
		});

		it("should not refresh pinned temporary git sources", async () => {
			const gitHost = "github.com";
			const gitPath = "test/extension";
			const hash = createHash("sha256").update(`git-${gitHost}-${gitPath}`).digest("hex").slice(0, 8);
			const cachedDir = join(tmpdir(), "pi-extensions", `git-${gitHost}`, hash, gitPath);
			const extensionFile = join(cachedDir, "pi-extensions", "session-breakdown.ts");

			rmSync(cachedDir, { recursive: true, force: true });
			mkdirSync(join(cachedDir, "pi-extensions"), { recursive: true });
			writeFileSync(
				join(cachedDir, "package.json"),
				JSON.stringify({ pi: { extensions: ["./pi-extensions"] } }, null, 2),
			);
			writeFileSync(extensionFile, "// pinned");

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
			};
			managerWithInternals.runCommand = async (command, args) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
			};

			await packageManager.resolveExtensionSources([`${gitSource}@main`], { temporary: true });

			expect(executedCommands).toEqual([]);
			expect(getFileContent(cachedDir, "pi-extensions/session-breakdown.ts")).toBe("// pinned");
		});
	});

	describe("scope-aware update", () => {
		it("should not install locally when source is only registered globally", async () => {
			setupRemoteAndInstall();

			// Add a new commit to remote
			createCommit(remoteDir, "extension.ts", "// v2", "Second commit");

			// The project-scope install path should not exist before or after update
			const projectGitDir = join(tempDir, ".pi", "git", "github.com", "test", "extension");
			expect(existsSync(projectGitDir)).toBe(false);

			await packageManager.update(gitSource);

			// Global install should be updated
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v2");

			// Project-scope directory should NOT have been created
			expect(existsSync(projectGitDir)).toBe(false);
		});
	});

	describe("gitHasAvailableUpdate", () => {
		it("reports no update when local matches remote HEAD", async () => {
			setupRemoteAndInstall();
			const hasUpdate = await (
				packageManager as unknown as { gitHasAvailableUpdate(p: string): Promise<boolean> }
			).gitHasAvailableUpdate(installedDir);
			expect(hasUpdate).toBe(false);
		});

		it("reports update available when remote HEAD advances", async () => {
			setupRemoteAndInstall();
			createCommit(remoteDir, "extension.ts", "// v2", "Mainline progress");
			const hasUpdate = await (
				packageManager as unknown as { gitHasAvailableUpdate(p: string): Promise<boolean> }
			).gitHasAvailableUpdate(installedDir);
			expect(hasUpdate).toBe(true);
		});

		it("reports update for stuck-on-feature-branch clone (matches no-ref reconciliation)", async () => {
			// Build a remote with a feature branch divergent from main, clone
			// it, and check out feature locally so `branch.<name>.merge` points
			// at origin/feature. Per the no-ref reconciliation contract,
			// gitHasAvailableUpdate must compare local HEAD to origin/HEAD
			// (the remote default), not to the locally tracked feature branch.
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");
			git(["checkout", "-b", "feature"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// feature", "Feature work");
			git(["checkout", "main"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// v2", "Mainline progress");

			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			git(["config", "--local", "user.email", "test@test.com"], installedDir);
			git(["config", "--local", "user.name", "Test"], installedDir);
			git(["checkout", "feature"], installedDir);
			expect(git(["rev-parse", "--abbrev-ref", "@{upstream}"], installedDir)).toBe("origin/feature");

			const hasUpdate = await (
				packageManager as unknown as { gitHasAvailableUpdate(p: string): Promise<boolean> }
			).gitHasAvailableUpdate(installedDir);
			expect(hasUpdate).toBe(true);
		});

		it("reports no update when remote HEAD output is malformed (silent failure)", async () => {
			// Pin two contracts in one test:
			// 1. getRemoteGitHead throws when ls-remote origin HEAD output
			//    doesn't match the strict /^([0-9a-f]{40})\s+HEAD$/m regex.
			// 2. gitHasAvailableUpdate's catch swallows that throw and returns
			//    false — the silent-failure shape the source-side fix protects
			//    against.
			setupRemoteAndInstall();
			const managerWithInternals = packageManager as unknown as {
				runCommandCapture: (
					command: string,
					args: string[],
					options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
				) => Promise<string>;
			};
			const originalCapture = managerWithInternals.runCommandCapture.bind(packageManager);
			managerWithInternals.runCommandCapture = async (command, args, options) => {
				if (command === "git" && args[0] === "ls-remote" && args[1] === "origin" && args[2] === "HEAD") {
					return "";
				}
				return originalCapture(command, args, options);
			};

			const hasUpdate = await (
				packageManager as unknown as { gitHasAvailableUpdate(p: string): Promise<boolean> }
			).gitHasAvailableUpdate(installedDir);
			expect(hasUpdate).toBe(false);
		});
	});
});
