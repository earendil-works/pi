/**
 * Pure helpers for the goal-mode extension.
 *
 * The extension keeps a small state machine in session custom entries so it can
 * survive resume, fork, and compaction. All mutation helpers in this file are
 * side-effect free and are covered by unit tests.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const GOAL_ENTRY_TYPE = "goal-mode";
export const GOAL_CONTEXT_TYPE = "goal-mode-context";

export type GoalStatus = "active" | "paused" | "complete" | "budget_limited";

export interface GoalBudget {
	tokens?: number;
	cost?: number;
}

export interface UsageTotals {
	tokens: number;
	cost: number;
}

export interface GoalState {
	objective: string;
	status: GoalStatus;
	budget?: GoalBudget;
	createdAt: number;
	updatedAt: number;
	progress: string[];
	/** Usage totals recorded when the goal was created, used for delta accounting. */
	baseline: UsageTotals;
	/** Whether the most recent turn ended with at least one tool result. */
	lastTurnHadToolCall?: boolean;
	/** Evidence text supplied to complete_goal when the goal was completed. */
	lastCompletionEvidence?: string;
}

export type GoalCommandResult =
	| { action: "set"; objective: string; budget: GoalBudget }
	| { action: "view" }
	| { action: "pause" }
	| { action: "resume" }
	| { action: "clear" }
	| { action: "invalid"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return value === "active" || value === "paused" || value === "complete" || value === "budget_limited";
}

function normalizeBudget(value: unknown): GoalBudget | undefined {
	if (!isRecord(value)) return undefined;
	const budget: GoalBudget = {};
	if (typeof value.tokens === "number" && Number.isFinite(value.tokens) && value.tokens >= 0) {
		budget.tokens = value.tokens;
	}
	if (typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0) {
		budget.cost = value.cost;
	}
	return budget.tokens === undefined && budget.cost === undefined ? undefined : budget;
}

function normalizeProgress(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

export function normalizeGoalState(value: unknown): GoalState | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.objective !== "string" || value.objective.trim().length === 0) return undefined;
	if (!isGoalStatus(value.status)) return undefined;
	if (typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") return undefined;

	const baseline =
		isRecord(value.baseline) &&
		typeof value.baseline.tokens === "number" &&
		Number.isFinite(value.baseline.tokens) &&
		value.baseline.tokens >= 0 &&
		typeof value.baseline.cost === "number" &&
		Number.isFinite(value.baseline.cost) &&
		value.baseline.cost >= 0
			? { tokens: value.baseline.tokens, cost: value.baseline.cost }
			: { tokens: 0, cost: 0 };

	return {
		objective: value.objective,
		status: value.status,
		budget: normalizeBudget(value.budget),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		progress: normalizeProgress(value.progress),
		baseline,
		lastTurnHadToolCall: typeof value.lastTurnHadToolCall === "boolean" ? value.lastTurnHadToolCall : undefined,
		lastCompletionEvidence:
			typeof value.lastCompletionEvidence === "string" ? value.lastCompletionEvidence : undefined,
	};
}

/** Find the most recent goal state on the active branch, if any. */
export function getLatestGoalState(entries: readonly SessionEntry[]): GoalState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== GOAL_ENTRY_TYPE) continue;
		return normalizeGoalState(entry.data);
	}
	return undefined;
}

export function createGoalState(
	objective: string,
	options: { budget?: GoalBudget; baseline?: UsageTotals; now?: number } = {},
): GoalState {
	const now = options.now ?? Date.now();
	return {
		objective: objective.trim(),
		status: "active",
		budget: options.budget,
		createdAt: now,
		updatedAt: now,
		progress: [],
		baseline: options.baseline ?? { tokens: 0, cost: 0 },
	};
}

/** Parse `/goal` command arguments into a state-machine operation. */
export function parseGoalCommand(rawArgs: string): GoalCommandResult {
	const args = rawArgs.trim();
	if (!args) return { action: "view" };
	if (args === "pause") return { action: "pause" };
	if (args === "resume") return { action: "resume" };
	if (args === "clear") return { action: "clear" };

	const budget: GoalBudget = {};
	const seen = new Set<string>();
	let objective = args;
	const flagPattern = /--(tokens|cost)\s+([^\s]+)/gi;
	const numberPattern = /^[0-9]+(?:\.[0-9]+)?$/;

	let match: RegExpExecArray | null;
	while (true) {
		match = flagPattern.exec(objective);
		if (match === null) break;
		const name = match[1]!.toLowerCase();
		if (seen.has(name)) {
			return { action: "invalid", message: `Duplicate --${name} flag` };
		}
		seen.add(name);
		const rawValue = match[2]!;
		const value = Number(rawValue);
		if (name === "tokens") {
			if (!numberPattern.test(rawValue) || !Number.isInteger(value) || value < 0) {
				return { action: "invalid", message: "--tokens must be a non-negative integer" };
			}
			budget.tokens = value;
		} else {
			if (!numberPattern.test(rawValue) || !Number.isFinite(value) || value < 0) {
				return { action: "invalid", message: "--cost must be a non-negative number" };
			}
			budget.cost = value;
		}
		objective = objective.slice(0, match.index) + " " + objective.slice(match.index + match[0].length);
		flagPattern.lastIndex = match.index;
	}

	const leftoverFlag = /--(tokens|cost)\b/i.exec(objective);
	if (leftoverFlag) {
		const name = leftoverFlag[1]!.toLowerCase();
		return {
			action: "invalid",
			message:
				name === "tokens" ? "--tokens must be a non-negative integer" : "--cost must be a non-negative number",
		};
	}

	objective = objective.replace(/\s+/g, " ").trim();
	if (!objective) {
		return { action: "invalid", message: "A goal objective is required" };
	}
	if (objective === "pause" || objective === "resume" || objective === "clear") {
		return {
			action: "invalid",
			message: `The ${objective} subcommand does not accept budget flags`,
		};
	}
	return { action: "set", objective, budget };
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

function addUsage(totals: UsageTotals, usage: UsageLike | undefined): void {
	if (!usage) return;
	totals.tokens += (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
	totals.cost += usage.cost?.total ?? 0;
}

/** Sum billed usage across the session branch, including compacted entries. */
export function computeUsageTotals(entries: readonly SessionEntry[]): UsageTotals {
	const totals: UsageTotals = { tokens: 0, cost: 0 };
	for (const entry of entries) {
		if (entry.type === "message") {
			const message = entry.message as { usage?: unknown };
			addUsage(totals, message.usage as UsageLike | undefined);
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			addUsage(totals, entry.usage as unknown as UsageLike | undefined);
		}
	}
	return totals;
}

/** Usage consumed since the goal was created. */
export function getGoalUsage(state: GoalState, entries: readonly SessionEntry[]): UsageTotals {
	const totals = computeUsageTotals(entries);
	return {
		tokens: Math.max(0, totals.tokens - state.baseline.tokens),
		cost: Math.max(0, totals.cost - state.baseline.cost),
	};
}

export function isBudgetExceeded(state: GoalState, usage: UsageTotals): boolean {
	if (state.budget?.tokens !== undefined && usage.tokens > state.budget.tokens) return true;
	if (state.budget?.cost !== undefined && usage.cost > state.budget.cost) return true;
	return false;
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3)}...`;
}

/** Append a compact progress line, keeping only the most recent entries. */
export function appendProgress(state: GoalState, text: string, now = Date.now(), maxEntries = 20): GoalState {
	const normalized = text.replace(/\s+/g, " ").trim();
	const content = normalized ? truncate(normalized, 200) : "";
	const line = content ? `[${new Date(now).toISOString().slice(11, 19)}] ${content}` : "";
	const last = state.progress[state.progress.length - 1];
	const lastContent = last ? last.slice(last.indexOf("] ") + 2) : undefined;
	if (!line || lastContent === content) {
		return { ...state, updatedAt: now };
	}
	const progress = [...state.progress, line];
	return {
		...state,
		progress: progress.slice(-maxEntries),
		updatedAt: now,
	};
}

const MIN_COMPLETION_EVIDENCE_LENGTH = 20;

/** Reject completion evidence that is too short to describe concrete verification. */
export function isValidCompletionEvidence(evidence: string): boolean {
	const normalized = evidence.replace(/\s+/g, " ").trim();
	return normalized.length >= MIN_COMPLETION_EVIDENCE_LENGTH && /[\p{L}\p{N}]/u.test(normalized);
}

export function formatGoalState(state: GoalState, usage?: UsageTotals): string {
	const lines = [`Goal: ${state.objective}`, `Status: ${state.status}`];
	if (state.budget?.tokens !== undefined || state.budget?.cost !== undefined) {
		const budget = state.budget;
		const used = usage ?? { tokens: 0, cost: 0 };
		const parts: string[] = [];
		if (budget.tokens !== undefined) parts.push(`tokens ${used.tokens}/${budget.tokens}`);
		if (budget.cost !== undefined) parts.push(`cost ${used.cost.toFixed(4)}/${budget.cost}`);
		lines.push(`Budget: ${parts.join(", ")}`);
	}
	if (state.lastCompletionEvidence) {
		lines.push(`Completed evidence: ${truncate(state.lastCompletionEvidence, 200)}`);
	}
	if (state.progress.length > 0) {
		lines.push("Progress:");
		for (const item of state.progress.slice(-10)) {
			lines.push(`- ${item}`);
		}
	}
	return lines.join("\n");
}

export function isGoalContextMessage(message: AgentMessage): boolean {
	return (message as { customType?: unknown }).customType === GOAL_CONTEXT_TYPE;
}

export function buildGoalContextMessage(state: GoalState, usage?: UsageTotals): AgentMessage {
	const budgetParts: string[] = [];
	if (state.budget?.tokens !== undefined) {
		budgetParts.push(usage ? `tokens ${usage.tokens}/${state.budget.tokens}` : `tokens ${state.budget.tokens}`);
	}
	if (state.budget?.cost !== undefined) {
		budgetParts.push(usage ? `cost ${usage.cost.toFixed(4)}/${state.budget.cost}` : `cost ${state.budget.cost}`);
	}
	const budget = budgetParts.length > 0 ? `\nBudget: ${budgetParts.join(", ")}` : "";
	return {
		role: "custom",
		customType: GOAL_CONTEXT_TYPE,
		content: `[GOAL MODE ACTIVE]

Active goal: ${state.objective}${budget}

Work autonomously toward this goal. Before each next step, inspect the current evidence in the conversation and the working tree. Call complete_goal only after the objective is verified against concrete evidence such as command output, test results, file changes, or generated artifacts, described in at least 20 characters. Do not call complete_goal based only on intent or a plausible summary.

If you are blocked or no defensible path remains, stop and explain the blocker in your response instead of calling complete_goal.`,
		display: false,
		timestamp: Date.now(),
	};
}

export function buildContinuationPrompt(state: GoalState): string {
	return `Continue the active goal: ${state.objective}

Inspect the current state, verify progress against concrete evidence, and take the next useful step. If the goal is now satisfied, call complete_goal with at least 20 characters of evidence (for example command output, test results, or file changes). If you are blocked, stop and report the blocker. Do not ask the user for permission for ordinary in-scope steps.`;
}

export function assistantHasToolCalls(message: AgentMessage | undefined): boolean {
	if (!message || message.role !== "assistant") return false;
	return message.content.some((part) => part.type === "toolCall");
}

export function getAssistantText(message: AgentMessage | undefined): string {
	if (!message || message.role !== "assistant") return "";
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}
