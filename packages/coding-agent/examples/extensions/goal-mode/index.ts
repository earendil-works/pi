/**
 * Goal Mode Extension
 *
 * A self-contained long-running goal mode for pi. It adds `/goal` lifecycle
 * commands, a `--goal` startup flag, thread-scoped persistent state, automatic
 * continuation while the goal is active, and a `complete_goal` tool that lets
 * the model finish only with concrete evidence.
 *
 * Usage:
 *   pi --extension examples/extensions/goal-mode/index.ts
 *   /goal Reduce checkout p95 below 120ms, verified by the benchmark
 *   /goal
 *   /goal pause
 *   /goal resume
 *   /goal clear
 *
 * Startup flag:
 *   pi --extension examples/extensions/goal-mode/index.ts --goal "Fix the flaky suite"
 */

import { basename } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	appendProgress,
	assistantHasToolCalls,
	buildContinuationPrompt,
	buildGoalContextMessage,
	computeUsageTotals,
	createGoalState,
	formatGoalState,
	type GoalBudget,
	type GoalState,
	getAssistantText,
	getGoalUsage,
	getLatestGoalState,
	isBudgetExceeded,
	isGoalContextMessage,
	isValidCompletionEvidence,
	parseGoalCommand,
} from "./utils.ts";

const ENTRY_TYPE = "goal-mode";
const BUDGET_TOKENS_FLAG = "goal-budget-tokens";
const BUDGET_COST_FLAG = "goal-budget-cost";

function persistGoal(pi: ExtensionAPI, goal: GoalState | undefined): void {
	pi.appendEntry(ENTRY_TYPE, goal ?? null);
}

function getBaseTitle(pi: ExtensionAPI): string {
	const cwd = basename(process.cwd());
	const sessionName = pi.getSessionName();
	return sessionName ? `pi - ${sessionName} - ${cwd}` : `pi - ${cwd}`;
}

function getGoalStatusLabel(status: GoalState["status"]): string {
	switch (status) {
		case "active":
			return "GOAL MODE";
		case "paused":
			return "GOAL PAUSED";
		case "complete":
			return "GOAL COMPLETE";
		case "budget_limited":
			return "GOAL BUDGET LIMITED";
	}
}

function updateStatus(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!goal) {
		ctx.ui.setStatus("goal-mode", "mode: build");
		ctx.ui.setWidget("goal-mode", undefined);
		ctx.ui.setTitle(getBaseTitle(pi));
		return;
	}

	const label = getGoalStatusLabel(goal.status);
	ctx.ui.setStatus("goal-mode", "mode: goal");
	ctx.ui.setWidget("goal-mode", getGoalWidgetLines(label));

	const titleObjective = goal.objective.length > 48 ? `${goal.objective.slice(0, 45)}...` : goal.objective;
	ctx.ui.setTitle(`[${label}] ${titleObjective}`);
}

function getGoalWidgetLines(label: string): string[] {
	if (!goal) return [];
	const lines = [`[${label}]`, `Objective: ${goal.objective}`];
	if (goal.budget?.tokens !== undefined || goal.budget?.cost !== undefined) {
		const budget = goal.budget;
		const parts: string[] = [];
		if (budget.tokens !== undefined) parts.push(`tokens ${budget.tokens}`);
		if (budget.cost !== undefined) parts.push(`cost ${budget.cost}`);
		lines.push(`Budget: ${parts.join(", ")}`);
	}
	if (goal.progress.length > 0) {
		lines.push("Progress:", ...goal.progress.slice(-3).map((line) => `  ${line}`));
	}
	return lines;
}

function parseBudgetFlags(pi: ExtensionAPI, ctx: ExtensionContext): GoalBudget {
	const budget: GoalBudget = {};
	const tokensValue = pi.getFlag(BUDGET_TOKENS_FLAG);
	if (typeof tokensValue === "string" && tokensValue.trim()) {
		const tokens = Number(tokensValue);
		if (Number.isInteger(tokens) && tokens >= 0) {
			budget.tokens = tokens;
		} else {
			ctx.ui.notify(`Ignoring invalid --goal-budget-tokens value: ${tokensValue}`, "warning");
		}
	}
	const costValue = pi.getFlag(BUDGET_COST_FLAG);
	if (typeof costValue === "string" && costValue.trim()) {
		const cost = Number(costValue);
		if (Number.isFinite(cost) && cost >= 0) {
			budget.cost = cost;
		} else {
			ctx.ui.notify(`Ignoring invalid --goal-budget-cost value: ${costValue}`, "warning");
		}
	}
	return budget;
}

function startGoal(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!goal || goal.status !== "active") return;
	if (!ctx.isIdle()) {
		// A user command changed the goal while a run is in flight. Stop the
		// current work and let agent_settled start the new goal instead of
		// queueing a duplicate continuation.
		pendingRestart = true;
		ctx.abort();
		return;
	}
	if (continuationQueued) return;
	continuationQueued = true;
	const prompt = buildContinuationPrompt(goal);
	pi.sendUserMessage(prompt);
}

function setGoal(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	next: GoalState | undefined,
	options: { notify?: string } = {},
): void {
	bumpGoalVersion();
	goal = next;
	persistGoal(pi, goal);
	updateStatus(pi, ctx);
	if (options.notify) {
		ctx.ui.notify(options.notify, "info");
	}
	if (goal?.status === "active") {
		startGoal(pi, ctx);
	} else {
		pendingRestart = false;
	}
}

function showGoal(_pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!goal) {
		ctx.ui.notify("No goal set. Use /goal <objective> to start one.", "info");
		return;
	}
	const usage =
		goal.budget?.tokens !== undefined || goal.budget?.cost !== undefined
			? getGoalUsage(goal, ctx.sessionManager.getBranch())
			: undefined;
	ctx.ui.notify(formatGoalState(goal, usage), "info");
}

function pauseGoal(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!goal) {
		ctx.ui.notify("No goal set.", "info");
		return;
	}
	if (goal.status !== "active") {
		ctx.ui.notify(`Goal is already ${goal.status}.`, "info");
		return;
	}
	// Stop any in-flight autonomous work before switching state, so pause takes
	// effect immediately instead of waiting for the current run to settle.
	ctx.abort();
	setGoal(pi, ctx, { ...goal, status: "paused", updatedAt: Date.now() }, { notify: "Goal paused." });
}

function resumeGoal(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!goal) {
		ctx.ui.notify("No goal set.", "info");
		return;
	}
	if (goal.status === "active" && goal.lastTurnHadToolCall !== false) {
		ctx.ui.notify("Goal is already active.", "info");
		return;
	}
	if (goal.status === "active" || goal.status === "budget_limited") {
		const resumed =
			goal.status === "budget_limited"
				? {
						...goal,
						status: "active" as const,
						// Resuming after budget exhaustion starts the budget over
						// from current usage, so the same objective can continue.
						baseline: computeUsageTotals(ctx.sessionManager.getBranch()),
						updatedAt: Date.now(),
					}
				: { ...goal, updatedAt: Date.now() };
		setGoal(pi, ctx, resumed, { notify: "Goal resumed." });
		return;
	}
	if (goal.status !== "paused") {
		ctx.ui.notify(`Goal cannot be resumed from status ${goal.status}.`, "info");
		return;
	}
	const resumed = { ...goal, status: "active" as const, updatedAt: Date.now() };
	setGoal(pi, ctx, resumed, { notify: "Goal resumed." });
}

function clearGoal(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!goal) {
		ctx.ui.notify("No goal set.", "info");
		return;
	}
	// Stop any in-flight autonomous work before clearing the goal, so the UI
	// returns to normal mode immediately instead of continuing the current run.
	ctx.abort();
	setGoal(pi, ctx, undefined, { notify: "Goal cleared." });
}

function reportWaitingForUser(ctx: ExtensionContext): void {
	if (!goal) return;
	ctx.ui.setStatus("goal-mode", "mode: goal (waiting)");
	ctx.ui.setWidget("goal-mode", getGoalWidgetLines("GOAL MODE (WAITING)"));
	const titleObjective = goal.objective.length > 48 ? `${goal.objective.slice(0, 45)}...` : goal.objective;
	ctx.ui.setTitle(`[GOAL MODE (WAITING)] ${titleObjective}`);
	ctx.ui.notify(
		"Goal is active but the last turn made no tool calls. Stopped to avoid spinning. Use /goal resume or send a message to continue.",
		"info",
	);
}

function transitionBudgetLimited(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!goal) return;
	bumpGoalVersion();
	pendingRestart = false;
	const limited = { ...goal, status: "budget_limited" as const, updatedAt: Date.now() };
	goal = limited;
	persistGoal(pi, goal);
	updateStatus(pi, ctx);
	ctx.ui.notify(
		"Goal budget exhausted. Work stopped. Use /goal resume to continue with a fresh budget, or set a new goal.",
		"warning",
	);
}

let goal: GoalState | undefined;
let pendingRestart = false;
let continuationQueued = false;
let goalVersion = 0;
let activeRunGoalVersion = -1;

function bumpGoalVersion(): void {
	goalVersion++;
}

export default function goalModeExtension(pi: ExtensionAPI): void {
	pi.registerFlag("goal", {
		description: "Start with an active goal objective",
		type: "string",
	});
	pi.registerFlag(BUDGET_TOKENS_FLAG, {
		description: "Optional token budget for --goal",
		type: "string",
	});
	pi.registerFlag(BUDGET_COST_FLAG, {
		description: "Optional cost budget for --goal",
		type: "string",
	});

	pi.registerCommand("goal", {
		description: "Set, view, pause, resume, or clear the current goal",
		argumentHint: "<objective> [--tokens N] [--cost N] | pause | resume | clear",
		getArgumentCompletions: (prefix) => {
			const subcommands = ["pause", "resume", "clear"];
			const trimmed = prefix.trimStart();
			if (trimmed === "") {
				return subcommands.map((value) => ({
					value,
					label: value,
					description:
						value === "pause"
							? "Pause the active goal"
							: value === "resume"
								? "Resume a paused goal"
								: "Clear the goal",
				}));
			}
			const filtered = subcommands.filter((value) => value.startsWith(trimmed));
			return filtered.length > 0
				? filtered.map((value) => ({
						value,
						label: value,
						description:
							value === "pause"
								? "Pause the active goal"
								: value === "resume"
									? "Resume a paused goal"
									: "Clear the goal",
					}))
				: null;
		},
		handler: async (args, ctx) => {
			const command = parseGoalCommand(args);
			switch (command.action) {
				case "view":
					showGoal(pi, ctx);
					return;
				case "pause":
					pauseGoal(pi, ctx);
					return;
				case "resume":
					resumeGoal(pi, ctx);
					return;
				case "clear":
					clearGoal(pi, ctx);
					return;
				case "invalid":
					ctx.ui.notify(command.message, "warning");
					return;
				case "set": {
					const next = createGoalState(command.objective, {
						budget:
							command.budget.tokens !== undefined || command.budget.cost !== undefined
								? command.budget
								: undefined,
						baseline: computeUsageTotals(ctx.sessionManager.getBranch()),
					});
					setGoal(pi, ctx, next, { notify: `Goal set: ${next.objective}` });
					return;
				}
			}
		},
	});

	pi.registerTool(
		defineTool({
			name: "complete_goal",
			label: "Complete Goal",
			description:
				"Mark the active goal complete. Use only after verifying the objective against concrete evidence in the conversation or working tree.",
			promptSnippet: "Mark the active goal complete with concrete evidence",
			promptGuidelines: [
				"Call complete_goal only when the active goal is verified against concrete evidence such as command output, tests, file changes, or generated artifacts, described in at least 20 characters.",
				"Do not call complete_goal to ask for permission, to report a blocker, or when the goal is paused.",
			],
			parameters: Type.Object({
				evidence: Type.String({
					description:
						"Concrete evidence that the goal objective is satisfied, at least 20 characters (for example command output, test results, or file changes)",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!goal) {
					throw new Error("No active goal to complete.");
				}
				if (goal.status !== "active") {
					throw new Error(`Goal cannot be completed from status ${goal.status}.`);
				}
				const evidence = params.evidence.replace(/\s+/g, " ").trim();
				if (!isValidCompletionEvidence(evidence)) {
					throw new Error(
						"Evidence must be at least 20 characters describing concrete verification, such as command output, test results, or file changes.",
					);
				}
				const completed: GoalState = {
					...goal,
					status: "complete",
					updatedAt: Date.now(),
					lastCompletionEvidence: evidence,
					progress: [...goal.progress, `Completed: ${evidence.slice(0, 200)}`].slice(-20),
				};
				bumpGoalVersion();
				goal = completed;
				pendingRestart = false;
				continuationQueued = false;
				persistGoal(pi, goal);
				updateStatus(pi, ctx);
				return {
					content: [{ type: "text", text: `Goal completed: ${completed.objective}` }],
					details: {
						objective: completed.objective,
						evidence,
					},
					terminate: true,
				};
			},
		}),
	);

	pi.on("session_start", async (event, ctx) => {
		pendingRestart = false;
		continuationQueued = false;
		activeRunGoalVersion = -1;
		bumpGoalVersion();
		goal = getLatestGoalState(ctx.sessionManager.getBranch());

		if (event.reason === "startup") {
			const flagGoal = pi.getFlag("goal");
			if (typeof flagGoal === "string" && flagGoal.trim()) {
				goal = createGoalState(flagGoal, {
					budget: parseBudgetFlags(pi, ctx),
					baseline: computeUsageTotals(ctx.sessionManager.getBranch()),
				});
				persistGoal(pi, goal);
			}
		}

		updateStatus(pi, ctx);

		if (goal?.status === "active" && event.reason !== "reload") {
			startGoal(pi, ctx);
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		pendingRestart = false;
		continuationQueued = false;
		activeRunGoalVersion = -1;
		bumpGoalVersion();
		goal = getLatestGoalState(ctx.sessionManager.getBranch());
		updateStatus(pi, ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (activeRunGoalVersion !== goalVersion) return;
		if (!goal || goal.status !== "active") return;

		const text = getAssistantText(event.message);
		const next = {
			...goal,
			lastTurnHadToolCall: event.toolResults.length > 0 || assistantHasToolCalls(event.message),
			updatedAt: Date.now(),
		};
		goal = text ? appendProgress(next, text) : next;
		persistGoal(pi, goal);
		updateStatus(pi, ctx);
	});

	pi.on("agent_start", async () => {
		continuationQueued = false;
		activeRunGoalVersion = goalVersion;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (activeRunGoalVersion === -1) return;
		if (!goal || goal.status !== "active") return;
		if (ctx.hasPendingMessages()) return;
		if (pendingRestart) {
			pendingRestart = false;
			startGoal(pi, ctx);
			return;
		}
		if (goal.lastTurnHadToolCall === false) {
			reportWaitingForUser(ctx);
			return;
		}
		if (isBudgetExceeded(goal, getGoalUsage(goal, ctx.sessionManager.getBranch()))) {
			transitionBudgetLimited(pi, ctx);
			return;
		}
		startGoal(pi, ctx);
	});

	pi.on("context", async (event, ctx) => {
		const messages = event.messages.filter((message) => !isGoalContextMessage(message));
		if (goal?.status === "active") {
			const usage =
				goal.budget?.tokens !== undefined || goal.budget?.cost !== undefined
					? getGoalUsage(goal, ctx.sessionManager.getBranch())
					: undefined;
			messages.push(buildGoalContextMessage(goal, usage));
		}
		return { messages };
	});
}
