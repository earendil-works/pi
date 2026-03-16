import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let resolvedBranch = "main";

vi.mock("child_process", () => ({
	spawnSync: vi.fn((_command: string, args: readonly string[]) => {
		if (args[1] === "symbolic-ref") {
			return { status: resolvedBranch ? 0 : 1, stdout: resolvedBranch ? `${resolvedBranch}\n` : "", stderr: "" };
		}
		return { status: 1, stdout: "", stderr: "" };
	}),
}));

import { FooterDataProvider } from "../src/core/footer-data-provider.js";

type WorktreeFixture = {
	worktreeDir: string;
	reftableDir: string;
};

function createPlainReftableRepo(tempDir: string): string {
	const repoDir = join(tempDir, "repo");
	mkdirSync(join(repoDir, ".git", "reftable"), { recursive: true });
	writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
	return repoDir;
}

function createPlainRepo(tempDir: string): string {
	const repoDir = join(tempDir, "repo");
	mkdirSync(join(repoDir, ".git"), { recursive: true });
	writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
	return repoDir;
}

function createReftableWorktree(tempDir: string): WorktreeFixture {
	const repoDir = join(tempDir, "repo");
	const commonGitDir = join(repoDir, ".git");
	const gitDir = join(commonGitDir, "worktrees", "src");
	const worktreeDir = join(tempDir, "worktree");
	const reftableDir = join(commonGitDir, "reftable");

	mkdirSync(gitDir, { recursive: true });
	mkdirSync(reftableDir, { recursive: true });
	mkdirSync(worktreeDir, { recursive: true });

	writeFileSync(join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);
	writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/.invalid\n");
	writeFileSync(join(gitDir, "commondir"), "../..\n");
	writeFileSync(join(reftableDir, "tables.list"), "0\n");

	return { worktreeDir, reftableDir };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const startedAt = Date.now();
	while (!condition()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("FooterDataProvider reftable branch detection", () => {
	let originalCwd: string;
	let tempDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "footer-data-provider-"));
		resolvedBranch = "main";
		vi.mocked(spawnSync).mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses HEAD directly in a regular repo from a nested directory", () => {
		const repoDir = createPlainRepo(tempDir);
		const nestedDir = join(repoDir, "src", "nested");
		mkdirSync(nestedDir, { recursive: true });
		process.chdir(nestedDir);

		const provider = new FooterDataProvider();
		try {
			expect(provider.getGitBranch()).toBe("main");
			expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via git when HEAD is .invalid in a reftable repo", () => {
		const repoDir = createPlainReftableRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider();
		try {
			expect(provider.getGitBranch()).toBe("main");
			expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
				"git",
				["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
				expect.objectContaining({
					cwd: expect.stringMatching(/repo$/),
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}),
			);
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via git in a reftable-backed worktree", () => {
		const { worktreeDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider();
		try {
			expect(provider.getGitBranch()).toBe("main");
		} finally {
			provider.dispose();
		}
	});

	it("treats an unresolved .invalid reftable HEAD as detached", () => {
		const repoDir = createPlainReftableRepo(tempDir);
		process.chdir(repoDir);
		resolvedBranch = "";

		const provider = new FooterDataProvider();
		try {
			expect(provider.getGitBranch()).toBe("detached");
		} finally {
			provider.dispose();
		}
	});

	it("does not notify listeners when reftable updates keep the same branch", async () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider();
		try {
			expect(provider.getGitBranch()).toBe("main");
			vi.mocked(spawnSync).mockClear();
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);

			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			await waitFor(() => vi.mocked(spawnSync).mock.calls.length > 0);

			expect(provider.getGitBranch()).toBe("main");
			expect(onBranchChange).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
		}
	});

	it("updates the cached branch when the reftable directory changes", async () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider();
		try {
			expect(provider.getGitBranch()).toBe("main");
			resolvedBranch = "foo";

			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error("Timed out waiting for branch change")), 2000);
				provider.onBranchChange(() => {
					clearTimeout(timeout);
					resolve();
				});
				writeFileSync(join(reftableDir, "tables.list"), "1\n");
			});

			expect(provider.getGitBranch()).toBe("foo");
		} finally {
			provider.dispose();
		}
	});
});
