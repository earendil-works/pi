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
	ctx.ui.setWidget("goal-mode", lines);

	const titleObjective = goal.objective.length > 48 ? `${goal.objective.slice(0, 45)}...` : goal.objective;
	ctx.ui.setTitle(`[${label}] ${titleObjective}`);
}

function parseBudgetFlags(pi: ExtensionAPI): GoalBudget {
	const budget: GoalBudget = {};
	const tokensValue = pi.getFlag(BUDGET_TOKENS_FLAG);
	if (typeof tokensValue === "string" && tokensValue.trim()) {
		const tokens = Number(tokensValue);
		if (Number.isFinite(tokens) && tokens >= 0) budget.tokens = tokens;
	}
	const costValue = pi.getFlag(BUDGET_COST_FLAG);
	if (typeof costValue === "string" && costValue.trim()) {
		const cost = Number(costValue);
		if (Number.isFinite(cost) && cost >= 0) budget.cost = cost;
	}
	return budget;
}

function startGoal(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!goal || goal.status !== "active") return;
	const prompt = buildContinuationPrompt(goal);
	if (ctx.isIdle()) {
		pi.sendUserMessage(prompt);
	} else {
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}
}

function setGoal(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	next: GoalState | undefined,
	options: { notify?: string } = {},
): void {
	goal = next;
	persistGoal(pi, goal);
	updateStatus(pi, ctx);
	if (options.notify) {
		ctx.ui.notify(options.notify, "info");
	}
	if (goal?.status === "active") {
		startGoal(pi, ctx);
	}
}

function showGoal(_pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!goal) {
		ctx.ui.notify("No goal set. Use /goal <objective> to start one.", "info");
		return;
	}
	const usage = goal.status === "active" ? getGoalUsage(goal, ctx.sessionManager.getBranch()) : undefined;
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
	if (goal.status !== "paused") {
		ctx.ui.notify(`Goal cannot be resumed from status ${goal.status}.`, "info");
		return;
	}
	const resumed = { ...goal, status: "active" as const, updatedAt: Date.now() };
	setGoal(pi, ctx, resumed, { notify: "Goal resumed." });
}

function clearGoal(pi: ExtensionAPI, ctx: ExtensionContext): void {
	// Stop any in-flight autonomous work before clearing the goal, so the UI
	// returns to normal mode immediately instead of continuing the current run.
	ctx.abort();
	setGoal(pi, ctx, undefined, { notify: "Goal cleared." });
}

function reportWaitingForUser(ctx: ExtensionContext): void {
	ctx.ui.setStatus("goal-mode", "goal: waiting");
	ctx.ui.notify(
		"Goal is active but the last turn made no tool calls. Stopped to avoid spinning. Use /goal resume or send a message to continue.",
		"info",
	);
}

function transitionBudgetLimited(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!goal) return;
	const limited = { ...goal, status: "budget_limited" as const, updatedAt: Date.now() };
	goal = limited;
	persistGoal(pi, goal);
	updateStatus(pi, ctx);
	ctx.ui.notify(
		"Goal budget exhausted. Work stopped; review progress and set a new goal or adjust the budget.",
		"warning",
	);
}

let goal: GoalState | undefined;

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
				"Call complete_goal only when the active goal is verified against concrete evidence such as command output, tests, file changes, or generated artifacts.",
				"Do not call complete_goal to ask for permission, to report a blocker, or when the goal is paused.",
			],
			parameters: Type.Object({
				evidence: Type.String({
					description: "Concrete evidence that the goal objective is satisfied",
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!goal) {
					throw new Error("No active goal to complete.");
				}
				if (goal.status !== "active") {
					throw new Error(`Goal cannot be completed from status ${goal.status}.`);
				}
				const completed: GoalState = {
					...goal,
					status: "complete",
					updatedAt: Date.now(),
					lastCompletionEvidence: params.evidence,
					progress: [
						...goal.progress,
						`Completed: ${params.evidence.replace(/\s+/g, " ").trim().slice(0, 200)}`,
					].slice(-20),
				};
				goal = completed;
				persistGoal(pi, goal);
				updateStatus(pi, ctx);
				return {
					content: [{ type: "text", text: `Goal completed: ${completed.objective}` }],
					details: {
						objective: completed.objective,
						evidence: params.evidence,
					},
					terminate: true,
				};
			},
		}),
	);

	pi.on("session_start", async (event, ctx) => {
		goal = getLatestGoalState(ctx.sessionManager.getBranch());

		if (event.reason === "startup") {
			const flagGoal = pi.getFlag("goal");
			if (typeof flagGoal === "string" && flagGoal.trim()) {
				goal = createGoalState(flagGoal, {
					budget: parseBudgetFlags(pi),
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

	pi.on("turn_end", async (event, ctx) => {
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

	pi.on("agent_settled", async (_event, ctx) => {
		if (!goal || goal.status !== "active") return;
		if (ctx.hasPendingMessages()) return;
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

	pi.on("context", async (event) => {
		const messages = event.messages.filter((message) => !isGoalContextMessage(message));
		if (goal?.status === "active") {
			messages.push(buildGoalContextMessage(goal));
		}
		return { messages };
	});
}
