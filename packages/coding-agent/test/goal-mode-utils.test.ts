import { describe, expect, it } from "vitest";
import {
	appendProgress,
	buildContinuationPrompt,
	buildGoalContextMessage,
	computeUsageTotals,
	createGoalState,
	formatGoalState,
	getGoalUsage,
	getLatestGoalState,
	isBudgetExceeded,
	isGoalContextMessage,
	isValidCompletionEvidence,
	normalizeGoalState,
	parseGoalCommand,
} from "../examples/extensions/goal-mode/utils.ts";

describe("parseGoalCommand", () => {
	it("parses view, pause, resume, and clear", () => {
		expect(parseGoalCommand("")).toEqual({ action: "view" });
		expect(parseGoalCommand("  ")).toEqual({ action: "view" });
		expect(parseGoalCommand("pause")).toEqual({ action: "pause" });
		expect(parseGoalCommand("resume")).toEqual({ action: "resume" });
		expect(parseGoalCommand("clear")).toEqual({ action: "clear" });
	});

	it("parses an objective with optional budgets", () => {
		expect(parseGoalCommand("Fix the flaky suite")).toEqual({
			action: "set",
			objective: "Fix the flaky suite",
			budget: {},
		});
		expect(parseGoalCommand("Fix tests --tokens 1000 --cost 2.5")).toEqual({
			action: "set",
			objective: "Fix tests",
			budget: { tokens: 1000, cost: 2.5 },
		});
		expect(parseGoalCommand("Fix tests --cost 1 --tokens 5")).toEqual({
			action: "set",
			objective: "Fix tests",
			budget: { tokens: 5, cost: 1 },
		});
		expect(parseGoalCommand("--tokens 100 Fix tests")).toEqual({
			action: "set",
			objective: "Fix tests",
			budget: { tokens: 100 },
		});
		expect(parseGoalCommand("Fix --cost 2.5 tests --tokens 10")).toEqual({
			action: "set",
			objective: "Fix tests",
			budget: { tokens: 10, cost: 2.5 },
		});
	});

	it("rejects empty objectives and invalid budgets", () => {
		expect(parseGoalCommand("--tokens 10")).toEqual({
			action: "invalid",
			message: "A goal objective is required",
		});
		expect(parseGoalCommand("Fix tests --tokens nope")).toEqual({
			action: "invalid",
			message: "--tokens must be a non-negative integer",
		});
		expect(parseGoalCommand("Fix tests --cost nope")).toEqual({
			action: "invalid",
			message: "--cost must be a non-negative number",
		});
		expect(parseGoalCommand("Fix --tokens nope tests")).toEqual({
			action: "invalid",
			message: "--tokens must be a non-negative integer",
		});
		expect(parseGoalCommand("Fix tests --cost -1")).toEqual({
			action: "invalid",
			message: "--cost must be a non-negative number",
		});
		expect(parseGoalCommand("Fix tests --tokens 1.")).toEqual({
			action: "invalid",
			message: "--tokens must be a non-negative integer",
		});
		expect(parseGoalCommand("Fix tests --tokens")).toEqual({
			action: "invalid",
			message: "--tokens must be a non-negative integer",
		});
		expect(parseGoalCommand("Fix tests --tokens 1 --tokens 2")).toEqual({
			action: "invalid",
			message: "Duplicate --tokens flag",
		});
		expect(parseGoalCommand("pause --tokens 5")).toEqual({
			action: "invalid",
			message: "The pause subcommand does not accept budget flags",
		});
	});
});

describe("goal state helpers", () => {
	it("creates an active goal with a usage baseline", () => {
		const state = createGoalState("Fix tests", {
			budget: { tokens: 100 },
			baseline: { tokens: 10, cost: 1 },
			now: 42,
		});
		expect(state).toMatchObject({
			objective: "Fix tests",
			status: "active",
			budget: { tokens: 100 },
			baseline: { tokens: 10, cost: 1 },
			createdAt: 42,
			updatedAt: 42,
			progress: [],
		});
		expect(createGoalState("  Fix\ntests   here ", { now: 1 }).objective).toBe("Fix tests here");
	});

	it("normalizes persisted state and rejects malformed data", () => {
		expect(normalizeGoalState(null)).toBeUndefined();
		expect(normalizeGoalState({ objective: "", status: "active" })).toBeUndefined();
		const state = createGoalState("Fix tests", { now: 1 });
		expect(normalizeGoalState(state)).toEqual(state);
		expect(normalizeGoalState({ ...state, baseline: { tokens: -5, cost: -1 } })?.baseline).toEqual({
			tokens: 0,
			cost: 0,
		});
	});

	it("appends capped progress entries", () => {
		let state = createGoalState("Fix tests", { now: 0 });
		state = appendProgress(state, "Ran the suite and fixed one failure", 1_000);
		expect(state.progress).toHaveLength(1);
		expect(state.progress[0]).toContain("Ran the suite");
		for (let i = 0; i < 25; i++) {
			state = appendProgress(state, `entry ${i}`, 2_000 + i);
		}
		expect(state.progress).toHaveLength(20);
		expect(state.progress[19]).toContain("entry 24");
	});

	it("skips empty and duplicate progress lines", () => {
		let state = createGoalState("Fix tests", { now: 0 });
		state = appendProgress(state, "   ", 1_000);
		expect(state.progress).toHaveLength(0);
		expect(state.updatedAt).toBe(1_000);

		state = appendProgress(state, "Ran the suite", 2_000);
		state = appendProgress(state, "Ran the suite", 3_000);
		expect(state.progress).toHaveLength(1);
		expect(state.updatedAt).toBe(3_000);
	});
});

describe("completion evidence", () => {
	it("requires concrete evidence of a minimum length", () => {
		expect(isValidCompletionEvidence("done")).toBe(false);
		expect(isValidCompletionEvidence("   ")).toBe(false);
		expect(isValidCompletionEvidence(".".repeat(20))).toBe(false);
		expect(isValidCompletionEvidence("suite passes with 0 failures")).toBe(true);
		expect(isValidCompletionEvidence("a".repeat(20))).toBe(true);
		expect(isValidCompletionEvidence("修复测试通过且无回归".repeat(2))).toBe(true);
	});
});

describe("goal persistence", () => {
	it("finds the most recent goal entry on the active branch", () => {
		const first = createGoalState("first", { now: 1 });
		const second = createGoalState("second", { now: 2 });
		const entries = [
			{
				type: "custom",
				customType: "goal-mode",
				data: first,
				id: "a",
				parentId: null,
				timestamp: "t1",
			},
			{
				type: "custom",
				customType: "goal-mode",
				data: second,
				id: "b",
				parentId: "a",
				timestamp: "t2",
			},
		] as const;
		expect(getLatestGoalState(entries)?.objective).toBe("second");
	});

	it("treats a cleared goal entry as no goal", () => {
		const state = createGoalState("first", { now: 1 });
		const entries = [
			{
				type: "custom",
				customType: "goal-mode",
				data: state,
				id: "a",
				parentId: null,
				timestamp: "t1",
			},
			{
				type: "custom",
				customType: "goal-mode",
				data: null,
				id: "b",
				parentId: "a",
				timestamp: "t2",
			},
		] as const;
		expect(getLatestGoalState(entries)).toBeUndefined();
	});
});

describe("usage accounting", () => {
	const entry = (usage: unknown) => ({
		type: "message",
		message: { usage },
		id: "m",
		parentId: null,
		timestamp: "t",
	});

	it("sums tokens and cost from message and summary entries", () => {
		const totals = computeUsageTotals([
			entry({
				input: 10,
				output: 5,
				cacheRead: 2,
				cacheWrite: 1,
				cost: { total: 0.25 },
			}),
			{
				type: "compaction",
				summary: "s",
				firstKeptEntryId: "m",
				tokensBefore: 0,
				usage: {
					input: 3,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { total: 0.05 },
				},
				id: "c",
				parentId: "m",
				timestamp: "t",
			},
		] as never);
		expect(totals).toEqual({ tokens: 22, cost: 0.3 });
	});

	it("computes delta usage since the goal baseline", () => {
		const state = createGoalState("Fix tests", { baseline: { tokens: 100, cost: 2 } });
		const usage = getGoalUsage(state, [
			entry({
				input: 50,
				output: 60,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 3 },
			}),
		] as never);
		expect(usage).toEqual({ tokens: 10, cost: 1 });
	});

	it("detects budget exhaustion", () => {
		const state = createGoalState("Fix tests", { budget: { tokens: 100, cost: 1 } });
		expect(isBudgetExceeded(state, { tokens: 100, cost: 0.5 })).toBe(false);
		expect(isBudgetExceeded(state, { tokens: 101, cost: 0.5 })).toBe(true);
		expect(isBudgetExceeded(state, { tokens: 50, cost: 1.01 })).toBe(true);
	});
});

describe("prompt formatting", () => {
	it("formats status with budget and progress", () => {
		const state = createGoalState("Fix tests", {
			budget: { tokens: 100 },
			now: 1,
		});
		const formatted = formatGoalState(state, { tokens: 10, cost: 0 });
		expect(formatted).toContain("Goal: Fix tests");
		expect(formatted).toContain("Status: active");
		expect(formatted).toContain("Budget: tokens 10/100");
	});

	it("builds an injectable context message", () => {
		const state = createGoalState("Fix tests", { now: 1 });
		const message = buildGoalContextMessage(state);
		expect(isGoalContextMessage(message)).toBe(true);
		const content =
			typeof (message as { content?: unknown }).content === "string" ? (message as { content: string }).content : "";
		expect(content).toContain("Active goal: Fix tests");
	});

	it("includes budget usage in the context message when provided", () => {
		const state = createGoalState("Fix tests", { budget: { tokens: 100, cost: 2 }, now: 1 });
		const message = buildGoalContextMessage(state, { tokens: 50, cost: 0.5 });
		const content =
			typeof (message as { content?: unknown }).content === "string" ? (message as { content: string }).content : "";
		expect(content).toContain("Budget: tokens 50/100, cost 0.5000/2");
	});

	it("builds a continuation prompt that references the objective", () => {
		const state = createGoalState("Fix tests", { now: 1 });
		expect(buildContinuationPrompt(state)).toContain("Fix tests");
		expect(buildContinuationPrompt(state)).toContain("complete_goal");
	});
});
