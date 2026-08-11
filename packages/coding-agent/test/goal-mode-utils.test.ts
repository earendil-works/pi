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
	});

	it("normalizes persisted state and rejects malformed data", () => {
		expect(normalizeGoalState(null)).toBeUndefined();
		expect(normalizeGoalState({ objective: "", status: "active" })).toBeUndefined();
		const state = createGoalState("Fix tests", { now: 1 });
		expect(normalizeGoalState(state)).toEqual(state);
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

	it("builds a continuation prompt that references the objective", () => {
		const state = createGoalState("Fix tests", { now: 1 });
		expect(buildContinuationPrompt(state)).toContain("Fix tests");
		expect(buildContinuationPrompt(state)).toContain("complete_goal");
	});
});
