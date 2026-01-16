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

const EMERGENCY_THRESHOLD = 0.95;

interface ThresholdContext {
	isAutoHandoffInProgress: boolean;
	modelContextWindow: number | null;
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

describe("Auto-Handoff Thresholds", () => {
	const makeUsage = (total: number): Usage => ({
		input: total * 0.8,
		output: total * 0.15,
		cacheRead: total * 0.03,
		cacheWrite: total * 0.02,
		totalTokens: total,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});

	describe("Emergency Threshold (0.95)", () => {
		const contextWindow = 200000;
		const baseCtx: ThresholdContext = {
			isAutoHandoffInProgress: false,
			modelContextWindow: contextWindow,
		};

		it("triggers at 95% with pending tools", () => {
			const msg = {
				usage: makeUsage(190000), // 95%
				stopReason: "toolUse" as const,
			};
			expect(shouldTriggerEmergencyHandoff(msg, baseCtx)).toBe(true);
		});

		it("triggers above 95%", () => {
			const msg = {
				usage: makeUsage(198000), // 99%
				stopReason: "toolUse" as const,
			};
			expect(shouldTriggerEmergencyHandoff(msg, baseCtx)).toBe(true);
		});

		it("does NOT trigger at 94%", () => {
			const msg = {
				usage: makeUsage(188000), // 94%
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
});
