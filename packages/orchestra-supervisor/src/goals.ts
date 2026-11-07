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

// Lazy shotd wiring: imports shotd only when a screenshot/dom check runs (off-by-default, zero cost when off).
export async function makeScreenshotDiffRunner(shotdRoot: string): Promise<(c: CheckRecord) => Promise<CheckOutcome>> {
	const { BrowserManager } = await import("@earendil-works/pi-shotd/browser");
	const { ShotStore } = await import("@earendil-works/pi-shotd/store");
	const { encodeArchive } = await import("@earendil-works/pi-shotd/image");
	const { diffImages } = await import("@earendil-works/pi-shotd/image");
	const store = new ShotStore(shotdRoot);
	const browser = new BrowserManager();
	return async (c) => {
		const cfg = c.config as { baselineName?: string; url?: string; threshold?: number };
		const baseline = store.readBaseline(String(cfg.baselineName ?? "default"));
		if (!baseline) {
			const output = `no baseline ${String(cfg.baselineName ?? "default")}`;
			return { checkId: c.id, passed: false, signature: failureSignature(c.id, output), output };
		}
		const shot = await browser.capture({ url: String(cfg.url ?? "about:blank") });
		const encoded = await encodeArchive(shot.png, {});
		const result = await diffImages(baseline, encoded.buf, { threshold: cfg.threshold ?? 0.001 });
		const output = `diff ${(result.percentChanged * 100).toFixed(4)}% changed (${result.changedPixels}/${result.totalPixels}) threshold ${(cfg.threshold ?? 0.001 * 100).toFixed(2)}%`;
		return { checkId: c.id, passed: result.passed, signature: failureSignature(c.id, output), output };
	};
}

export async function makeDomAssertRunner(): Promise<(c: CheckRecord) => Promise<CheckOutcome> & unknown> {
	const { BrowserManager } = await import("@earendil-works/pi-shotd/browser");
	const browser = new BrowserManager();
	const handler = async (c: CheckRecord): Promise<CheckOutcome> => {
		const cfg = c.config as { url?: string; selectors?: string[]; expectWidth?: number };
		const metrics = await browser.domMetrics(String(cfg.url ?? "about:blank"), cfg.selectors ?? []);
		const first = metrics[0];
		const passed = !!(
			first?.found &&
			(cfg.expectWidth === undefined || Math.abs((first.rect?.width ?? 0) - cfg.expectWidth) < 1)
		);
		const output = JSON.stringify(metrics).slice(0, 2000);
		return { checkId: c.id, passed, signature: failureSignature(c.id, output), output };
	};
	return handler as unknown as (c: CheckRecord) => Promise<CheckOutcome> & unknown;
}

export class GoalEngine {
	readonly store: Store;
	constructor(store: Store) {
		this.store = store;
	}

	/** Run all required checks for task in worktree cwd. Records check_runs. Returns outcomes. */
	async runChecksAsync(
		taskId: string,
		cwd: string,
		opts: {
			screenshotDiff?: (c: CheckRecord) => Promise<CheckOutcome> | CheckOutcome;
			domAssert?: (c: CheckRecord) => Promise<CheckOutcome> | CheckOutcome;
		} = {},
	): Promise<CheckOutcome[]> {
		const task = this.store.getTask(taskId);
		if (!task) return [];
		const checks = this.store.listChecks(taskId).filter((c) => c.required);
		const outcomes: CheckOutcome[] = [];
		for (const check of checks) {
			const attempt = task.attempts + 1;
			let outcome: CheckOutcome;
			if (check.kind === "cmd") outcome = runCmdCheck(check, cwd);
			else if (check.kind === "screenshot_diff" && opts.screenshotDiff) outcome = await opts.screenshotDiff(check);
			else if (check.kind === "dom_assert" && opts.domAssert) outcome = await opts.domAssert(check);
			else
				outcome = {
					checkId: check.id,
					passed: false,
					signature: failureSignature(check.id, "no runner"),
					output: "no runner for check kind",
				};
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
