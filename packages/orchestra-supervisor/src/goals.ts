// Goal engine: run acceptance checks in the agent's worktree. Worker claim counts for nothing.
import { execFileSync } from "node:child_process";
import type { CheckRecord } from "@earendil-works/pi-orchestra-core";
import { failureSignature, type Store } from "@earendil-works/pi-orchestra-core";

export interface CheckOutcome {
	checkId: string;
	passed: boolean;
	signature: string;
	output: string;
	flaky?: boolean;
}

export function runCmdCheck(check: CheckRecord, cwd: string): CheckOutcome {
	const cfg = check.config as { command?: string; argv?: string[]; timeoutMs?: number };
	const cmd = cfg.command ?? "";
	const argv = cfg.argv ?? [];
	let output = "";
	let passed = false;
	try {
		output = execFileSync(cmd === "" ? "sh" : cmd, cmd === "" ? ["-c", String(cfg.argv?.join(" ") ?? "")] : argv, {
			cwd,
			timeout: cfg.timeoutMs ?? 60_000,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).toString();
		passed = true;
	} catch (e) {
		const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string; status?: number | null };
		output = `${err.stdout?.toString() ?? ""}\n${err.stderr?.toString() ?? ""}\n${err.message ?? String(e)}`.slice(
			-8192,
		);
		passed = false;
	}
	return { checkId: check.id, passed, signature: failureSignature(check.id, output), output };
}

export class GoalEngine {
	readonly store: Store;
	constructor(store: Store) {
		this.store = store;
	}

	/** Run all required checks for task in worktree cwd. Records check_runs. Returns outcomes. */
	runChecks(
		taskId: string,
		cwd: string,
		opts: { screenshotDiff?: (c: CheckRecord) => CheckOutcome; domAssert?: (c: CheckRecord) => CheckOutcome } = {},
	): CheckOutcome[] {
		const task = this.store.getTask(taskId);
		if (!task) return [];
		const checks = this.store.listChecks(taskId).filter((c) => c.required);
		const outcomes: CheckOutcome[] = [];
		for (const check of checks) {
			const attempt = task.attempts + 1;
			let outcome: CheckOutcome;
			if (check.kind === "cmd") outcome = runCmdCheck(check, cwd);
			else if (check.kind === "screenshot_diff" && opts.screenshotDiff) outcome = opts.screenshotDiff(check);
			else if (check.kind === "dom_assert" && opts.domAssert) outcome = opts.domAssert(check);
			else
				outcome = {
					checkId: check.id,
					passed: false,
					signature: failureSignature(check.id, "no runner"),
					output: "no runner for check kind",
				};
			// Flaky: fails then passes on untouched rerun → record, don't count as progress.
			if (!outcome.passed && check.kind === "cmd") {
				const rerun = runCmdCheck(check, cwd);
				if (rerun.passed) {
					outcome.flaky = true;
					this.store.addCheckRun({
						checkId: check.id,
						attempt,
						passed: false,
						signature: outcome.signature,
						outputPath: null,
					});
					this.store.addCheckRun({
						checkId: check.id,
						attempt,
						passed: true,
						signature: rerun.signature,
						outputPath: null,
					});
					outcomes.push({ ...outcome, passed: false, flaky: true });
					continue;
				}
			}
			this.store.addCheckRun({
				checkId: check.id,
				attempt,
				passed: outcome.passed,
				signature: outcome.signature,
				outputPath: null,
			});
			outcomes.push(outcome);
		}
		return outcomes;
	}

	/** After work attempt: all required passed → done, else stays verifying; same signature N → escalate. */
	decide(taskId: string, outcomes: CheckOutcome[], opts: { stallN?: number } = {}): "done" | "retry" | "stalled" {
		const task = this.store.getTask(taskId)!;
		const allPassed = outcomes.length > 0 && outcomes.every((o) => o.passed);
		if (allPassed) {
			this.store.setTaskState(taskId, "done");
			return "done";
		}
		this.store.bumpTaskAttempts(taskId);
		const stallN = opts.stallN ?? 3;
		// Check last N runs of the first failing check share signature.
		const failing = outcomes.find((o) => !o.passed);
		if (failing) {
			const recent = this.store.lastRuns(failing.checkId, stallN);
			if (recent.length >= stallN && recent.every((r) => r.signature === failing.signature && !r.passed)) {
				this.store.setTaskState(taskId, "escalated");
				this.store.addEscalation({
					agentId: task.ownerAgentId,
					reason: `task ${taskId} stalled: same signature ${failing.signature} ×${stallN}`,
				});
				return "stalled";
			}
		}
		this.store.setTaskState(taskId, "in_progress");
		return "retry";
	}
}
