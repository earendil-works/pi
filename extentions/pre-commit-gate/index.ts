/**
 * Pre-Session Gate Extension
 *
 * Intercepts /new — if there are uncommitted changes,
 * cancels the switch and runs a quality pass before allowing /new.
 * No automatic commit is performed.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const GATE_MARKER = "[pre-commit-gate]";
const SNAPSHOT_ROOT = join(process.env.HOME ?? "", ".pi", "agent", "git", "pre-gate-snapshots");

/** Find the git root for a directory, or null if not in a git repo */
function findGitRoot(cwd: string): string | null {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8" }).trim();
	} catch {
		return null;
	}
}

/** Find all git repos — either cwd itself, or immediate subdirectories with .git */
function findGitRepos(cwd: string): string[] {
	// Check if cwd itself is a git repo
	const root = findGitRoot(cwd);
	if (root) return [root];

	// Otherwise scan immediate subdirectories for git repos
	const repos: string[] = [];
	try {
		for (const entry of readdirSync(cwd, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const subdir = join(cwd, entry.name);
			try {
				statSync(join(subdir, ".git"));
				repos.push(subdir);
			} catch {
				// not a git repo
			}
		}
	} catch {
		// can't read directory
	}
	return repos;
}

function hasUncommittedChanges(repoDir: string): boolean {
	try {
		const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf-8" }).trim();
		return status.length > 0;
	} catch {
		return false;
	}
}

function getChangedFiles(repoDir: string): string[] {
	try {
		const tracked = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim();
		const staged = execFileSync("git", ["diff", "--name-only", "--staged"], { cwd: repoDir, encoding: "utf-8" }).trim();
		const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repoDir, encoding: "utf-8" }).trim();
		return [...tracked.split("\n"), ...staged.split("\n"), ...untracked.split("\n")].filter(Boolean);
	} catch {
		return [];
	}
}

function getUntrackedFiles(repoDir: string): string[] {
	try {
		const output = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
			cwd: repoDir,
			encoding: "utf-8",
		}).trim();
		return output ? output.split("\n").filter(Boolean) : [];
	} catch {
		return [];
	}
}

function classifyFiles(files: string[]): { hasCode: boolean; hasLogic: boolean; hasFrontend: boolean } {
	let hasCode = false;
	let hasLogic = false;
	let hasFrontend = false;

	for (const f of files) {
		if (/\.(ts|js|tsx|jsx|py|go|rs)$/.test(f)) hasCode = true;
		if (/\.(tsx|jsx)$/.test(f)) hasFrontend = true;
		if (/\.(ts|js|tsx|jsx)$/.test(f) && !/\.(css|scss|less|style)/.test(f)) hasLogic = true;
	}

	return { hasCode, hasLogic, hasFrontend };
}

function toSnapshotSlug(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

function snapshotTimestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Create a local safety snapshot for dirty repo state:
 * - staged patch
 * - unstaged patch
 * - copies of untracked files
 */
function createRepoSnapshot(repoDir: string): string | null {
	try {
		const repoTag = toSnapshotSlug(`${basename(repoDir)}-${repoDir}`);
		const snapshotDir = join(SNAPSHOT_ROOT, `${snapshotTimestamp()}-${repoTag}`);
		mkdirSync(snapshotDir, { recursive: true });

		const stagedPatch = execFileSync("git", ["diff", "--binary", "--staged"], { cwd: repoDir, encoding: "utf-8" });
		const unstagedPatch = execFileSync("git", ["diff", "--binary"], { cwd: repoDir, encoding: "utf-8" });
		writeFileSync(join(snapshotDir, "staged.patch"), stagedPatch, "utf-8");
		writeFileSync(join(snapshotDir, "unstaged.patch"), unstagedPatch, "utf-8");

		const untracked = getUntrackedFiles(repoDir);
		for (const relativePath of untracked) {
			const sourcePath = join(repoDir, relativePath);
			const targetPath = join(snapshotDir, "untracked", relativePath);
			try {
				const stats = statSync(sourcePath);
				if (!stats.isFile()) continue;
				mkdirSync(dirname(targetPath), { recursive: true });
				copyFileSync(sourcePath, targetPath);
			} catch {
				// ignore per-file copy failures
			}
		}

		const metadata = {
			repoDir,
			createdAt: new Date().toISOString(),
			branch: execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim(),
			head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim(),
			untrackedCount: untracked.length,
		};
		writeFileSync(join(snapshotDir, "meta.json"), JSON.stringify(metadata, null, 2), "utf-8");

		return snapshotDir;
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let pendingNewSession = false;
	let dirtyReposForGate: string[] = [];
	let snapshotDirsForGate: string[] = [];

	pi.registerCommand("pregate", {
		description: "Toggle pre-commit gate on /new (on/off)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(`Pre-commit gate: ${enabled ? "ON" : "OFF"}`, "info");
		},
	});

	pi.on("session_before_switch", (event, ctx) => {
		if (!enabled) return;
		if (event.reason !== "new") return;

		// Don't re-intercept if we're completing a gate cycle
		if (pendingNewSession) {
			pendingNewSession = false;
			return; // allow the switch
		}

		// Find git repos — either cwd or subdirectories
		const repos = findGitRepos(ctx.cwd);
		const dirtyRepos = repos.filter((r) => hasUncommittedChanges(r));
		if (dirtyRepos.length === 0) return;

		// Track repos/snapshots for completion notifications
		dirtyReposForGate = dirtyRepos;
		snapshotDirsForGate = dirtyRepos
			.map((repo) => createRepoSnapshot(repo))
			.filter((snapshot): snapshot is string => Boolean(snapshot));

		// Collect all changed files across dirty repos
		const allFiles: string[] = [];
		for (const repo of dirtyRepos) {
			allFiles.push(...getChangedFiles(repo));
		}
		const { hasCode, hasLogic, hasFrontend } = classifyFiles(allFiles);
		const repoList = dirtyRepos.map((repo) => `- ${repo}`).join("\n");
		const snapshotList =
			snapshotDirsForGate.length > 0
				? snapshotDirsForGate.map((snapshot) => `- ${snapshot}`).join("\n")
				: "- snapshot creation failed";

		const fixAgents: string[] = [];
		if (hasLogic) {
			fixAgents.push(`- reviewer agent (mode "tdd"): enforce TDD discipline and fix violations`);
		}
		if (hasFrontend) {
			fixAgents.push(`- frontend agent (mode "fix"): fix React/UI anti-patterns`);
		}

		let step = 1;
		const steps: string[] = [];
		steps.push(`${step++}. Review pending changes first (\`git status --short\` and \`git diff\`).`);
		if (fixAgents.length > 0) {
			steps.push(`${step++}. Run quality fix agents in parallel:\n${fixAgents.join("\n")}`);
		}
		if (hasCode) {
			steps.push(`${step++}. Run tester agent (depth "targeted") and fix any failing checks/tests.`);
			steps.push(`${step++}. Run sentinel agent (mode "diff") for final security audit. Fix P0/P1 findings.`);
		}
		steps.push(`${step++}. Reply exactly "GATE_COMPLETE" when finished.`);

		const prompt = `${GATE_MARKER} You were about to start a new session, but there are uncommitted changes.

Dirty repos:
${repoList}

Safety snapshots:
${snapshotList}

No automatic commit will run. Keep full manual control of staging and commits.

${steps.join("\n\n")}`;

		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		return { cancel: true };
	});

	// After the gate pipeline finishes, unlock one /new without rerunning the gate.
	pi.on("agent_end", (event, ctx) => {
		let isGateRun = false;
		let isComplete = false;
		let wasAborted = false;

		for (const msg of event.messages) {
			if (msg.role === "user") {
				for (const part of msg.content) {
					if (part.type === "text" && part.text.includes(GATE_MARKER)) {
						isGateRun = true;
					}
				}
			}
			if (msg.role === "assistant") {
				for (const part of msg.content) {
					if (part.type === "text" && part.text.includes("GATE_COMPLETE")) {
						isComplete = true;
					}
				}
				if (msg.stopReason === "aborted" || msg.stopReason === "error") {
					wasAborted = true;
				}
			}
		}

		if (!isGateRun) return;

		if (!isComplete) {
			if (wasAborted) {
				pendingNewSession = true;
				dirtyReposForGate = [];
				snapshotDirsForGate = [];
				ctx.ui.notify("Pre-commit gate cancelled. Next /new will proceed without gate.", "warning");
			}
			return;
		}

		const stillDirty = dirtyReposForGate.filter((repo) => hasUncommittedChanges(repo));
		dirtyReposForGate = [];

		if (stillDirty.length > 0) {
			ctx.ui.notify(`Gate complete. Repos still dirty (${stillDirty.length}). Review and commit manually.`, "info");
		} else {
			ctx.ui.notify("Gate complete. Working trees are clean.", "info");
		}

		if (snapshotDirsForGate.length > 0) {
			ctx.ui.notify(`Snapshots saved under: ${SNAPSHOT_ROOT}`, "info");
		}
		snapshotDirsForGate = [];

		pendingNewSession = true;
		ctx.ui.notify("Run /new again to start a fresh session.", "info");
	});
}
