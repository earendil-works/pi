/**
 * Verification: Auto-handoff threshold detection logic
 *
 * Tests the threshold calculation and guard conditions.
 * Does NOT test full handoff flow (that requires TUI integration).
 */

import type { AssistantMessage, Usage } from "@kennyfrc/pi-ai";
import { describe, expect, it } from "vitest";

// Extract the threshold detection logic for unit testing
// This mirrors the logic that will be in tui-renderer.ts

const EMERGENCY_THRESHOLD = 0.97;
const NORMAL_THRESHOLD = 0.9;

interface ThresholdContext {
	isAutoHandoffInProgress: boolean;
	modelContextWindow: number | null;
	hasError: boolean;
}

function calculateRatioFromUsage(usage: Usage, contextWindow: number): number {
	const contextTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return contextWindow > 0 ? contextTokens / contextWindow : 0;
}

function shouldTriggerEmergencyHandoff(
	msg: Pick<AssistantMessage, "usage" | "stopReason">,
	ctx: ThresholdContext,
): boolean {
	if (ctx.isAutoHandoffInProgress) return false;
	if (!ctx.modelContextWindow) return false;
	if (msg.stopReason !== "toolUse") return false;

	const ratio = calculateRatioFromUsage(msg.usage, ctx.modelContextWindow);
	return ratio >= EMERGENCY_THRESHOLD;
}

function shouldTriggerNormalHandoff(ratio: number, ctx: ThresholdContext): boolean {
	if (ctx.isAutoHandoffInProgress) return false;
	if (!ctx.modelContextWindow) return false;
	if (ctx.hasError) return false;

	return ratio >= NORMAL_THRESHOLD;
}

describe("Auto-Handoff Thresholds", () => {
	const makeUsage = (total: number): Usage => ({
		input: total * 0.8,
		output: total * 0.15,
		cacheRead: total * 0.03,
		cacheWrite: total * 0.02,
		totalTokens: total,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});

	describe("Emergency Threshold (0.97)", () => {
		const contextWindow = 200000;
		const baseCtx: ThresholdContext = {
			isAutoHandoffInProgress: false,
			modelContextWindow: contextWindow,
			hasError: false,
		};

		it("triggers at 97% with pending tools", () => {
			const msg = {
				usage: makeUsage(194000), // 97%
				stopReason: "toolUse" as const,
			};
			expect(shouldTriggerEmergencyHandoff(msg, baseCtx)).toBe(true);
		});

		it("triggers above 97%", () => {
			const msg = {
				usage: makeUsage(198000), // 99%
				stopReason: "toolUse" as const,
			};
			expect(shouldTriggerEmergencyHandoff(msg, baseCtx)).toBe(true);
		});

		it("does NOT trigger at 96%", () => {
			const msg = {
				usage: makeUsage(192000), // 96%
				stopReason: "toolUse" as const,
			};
			expect(shouldTriggerEmergencyHandoff(msg, baseCtx)).toBe(false);
		});

		it("does NOT trigger without pending tools (stopReason=stop)", () => {
			const msg = {
				usage: makeUsage(198000), // 99%
				stopReason: "stop" as const,
			};
			expect(shouldTriggerEmergencyHandoff(msg, baseCtx)).toBe(false);
		});

		it("does NOT trigger if handoff already in progress", () => {
			const msg = {
				usage: makeUsage(198000),
				stopReason: "toolUse" as const,
			};
			const ctx = { ...baseCtx, isAutoHandoffInProgress: true };
			expect(shouldTriggerEmergencyHandoff(msg, ctx)).toBe(false);
		});

		it("does NOT trigger without model", () => {
			const msg = {
				usage: makeUsage(198000),
				stopReason: "toolUse" as const,
			};
			const ctx = { ...baseCtx, modelContextWindow: null };
			expect(shouldTriggerEmergencyHandoff(msg, ctx)).toBe(false);
		});
	});

	describe("Normal Threshold (0.90)", () => {
		const contextWindow = 200000;
		const baseCtx: ThresholdContext = {
			isAutoHandoffInProgress: false,
			modelContextWindow: contextWindow,
			hasError: false,
		};

		it("triggers at 90%", () => {
			const ratio = 180000 / contextWindow; // 90%
			expect(shouldTriggerNormalHandoff(ratio, baseCtx)).toBe(true);
		});

		it("triggers above 90%", () => {
			const ratio = 190000 / contextWindow; // 95%
			expect(shouldTriggerNormalHandoff(ratio, baseCtx)).toBe(true);
		});

		it("does NOT trigger at 89%", () => {
			const ratio = 178000 / contextWindow; // 89%
			expect(shouldTriggerNormalHandoff(ratio, baseCtx)).toBe(false);
		});

		it("does NOT trigger if handoff already in progress", () => {
			const ratio = 190000 / contextWindow;
			const ctx = { ...baseCtx, isAutoHandoffInProgress: true };
			expect(shouldTriggerNormalHandoff(ratio, ctx)).toBe(false);
		});

		it("does NOT trigger with error", () => {
			const ratio = 190000 / contextWindow;
			const ctx = { ...baseCtx, hasError: true };
			expect(shouldTriggerNormalHandoff(ratio, ctx)).toBe(false);
		});

		it("does NOT trigger without model", () => {
			const ratio = 190000 / contextWindow;
			const ctx = { ...baseCtx, modelContextWindow: null };
			expect(shouldTriggerNormalHandoff(ratio, ctx)).toBe(false);
		});
	});

	describe("Threshold Interaction", () => {
		it("emergency (97%) and normal (90%) are distinct ranges", () => {
			expect(EMERGENCY_THRESHOLD).toBeGreaterThan(NORMAL_THRESHOLD);
			// Gap ensures normal fires at agent_end, emergency at message_end
			expect(EMERGENCY_THRESHOLD - NORMAL_THRESHOLD).toBeCloseTo(0.07, 2);
		});

		it("at 95%, only normal threshold would trigger (not emergency)", () => {
			const contextWindow = 200000;
			const usage = makeUsage(190000); // 95%
			const ratio = calculateRatioFromUsage(usage, contextWindow);

			const ctx: ThresholdContext = {
				isAutoHandoffInProgress: false,
				modelContextWindow: contextWindow,
				hasError: false,
			};

			// Emergency requires toolUse, but even with it, 95% < 97%
			const msg = { usage, stopReason: "toolUse" as const };
			expect(shouldTriggerEmergencyHandoff(msg, ctx)).toBe(false);

			// Normal triggers at 95% > 90%
			expect(shouldTriggerNormalHandoff(ratio, ctx)).toBe(true);
		});
	});
});
