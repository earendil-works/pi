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
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

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

	// Git source that maps to our installed directory structure
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
		git(["init"], remoteDir);
		git(["config", "--local", "user.email", "test@test.com"], remoteDir);
		git(["config", "--local", "user.name", "Test"], remoteDir);
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

			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(latestCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v3");
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
		it("should not update pinned git sources (with @ref)", async () => {
			// Create remote repo first to get the initial commit
			mkdirSync(remoteDir, { recursive: true });
			git(["init"], remoteDir);
			git(["config", "--local", "user.email", "test@test.com"], remoteDir);
			git(["config", "--local", "user.name", "Test"], remoteDir);
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

			// Update should be skipped for pinned sources
			await packageManager.update();

			// Should still be on initial commit
			expect(getCurrentCommit(installedDir)).toBe(initialCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
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
			};
			managerWithInternals.runCommand = async (command, args) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				if (command === "git" && args[0] === "reset") {
					writeFileSync(extensionFile, "// fresh");
				}
			};

			await packageManager.resolveExtensionSources([gitSource], { temporary: true });

			expect(executedCommands).toContain("git fetch --prune origin");
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
});
