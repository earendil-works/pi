/**
 * Capture commits and working-tree diff after a worker-loop task. Mirrors
 * `captureGitState` in boss-pi's PiProcess.ts so the AgentTaskResult shape
 * stays identical across the host wrapper and pi-mono.
 *
 * All probes are best-effort. A missing repo, no HEAD, or oversized diff
 * means "no new state" — the worker still publishes a result.
 */
import { execSync } from "node:child_process";

export interface GitStateCapture {
	commits: string[];
	workingDiff?: string;
	committedDiff?: string;
}

/** Resolve HEAD before the task runs. Returns undefined outside a repo. */
export function resolveHeadSha(cwd: string): string | undefined {
	try {
		const out = execSync("git rev-parse HEAD", {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * After a task, list any commits made since `headSha`, capture the diff of
 * those commits vs `headSha`, and capture any leftover working-tree diff.
 */
export function captureGitState(cwd: string, headSha: string | undefined): GitStateCapture {
	if (!headSha) return { commits: [] };

	let commits: string[] = [];
	let workingDiff: string | undefined;
	let committedDiff: string | undefined;

	try {
		const logOut = execSync(`git log ${headSha}..HEAD --format=%H --reverse`, {
			cwd,
			encoding: "utf-8",
			maxBuffer: 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
		commits = logOut.trim().split("\n").filter(Boolean);
	} catch {
		// Non-fatal: no commits / not a repo.
	}

	if (commits.length > 0) {
		try {
			const out = execSync(`git diff ${headSha}..HEAD`, {
				cwd,
				encoding: "utf-8",
				maxBuffer: 4 * 1024 * 1024,
				stdio: ["ignore", "pipe", "ignore"],
			});
			if (out.trim()) committedDiff = out;
		} catch {
			// Non-fatal.
		}
	}

	try {
		const diffOut = execSync("git diff", {
			cwd,
			encoding: "utf-8",
			maxBuffer: 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (diffOut.trim()) workingDiff = diffOut;
	} catch {
		// Non-fatal.
	}

	return { commits, workingDiff, committedDiff };
}
