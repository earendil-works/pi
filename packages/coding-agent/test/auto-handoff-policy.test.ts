/**
 * Auto-handoff policy gating
 *
 * Auto-handoff must be disabled by default and only run when enabled.
 */

import { describe, expect, it } from "vitest";

import {
	AUTO_HANDOFF_EMERGENCY_THRESHOLD,
	AUTO_HANDOFF_STANDARD_THRESHOLD,
	getAutoCompactionContextWindow,
	isTargetedAutoCompactionModel,
	shouldAutoCompactForModel,
	shouldEnableHandoffNudge,
	shouldTriggerEmergencyAutoHandoff,
	shouldTriggerStandardAutoHandoff,
} from "../src/auto-handoff.js";

describe("Auto-handoff policy", () => {
	it("uses expected threshold", () => {
		expect(AUTO_HANDOFF_EMERGENCY_THRESHOLD).toBe(0.95);
		expect(AUTO_HANDOFF_STANDARD_THRESHOLD).toBe(0.9);
	});

	describe("targeted 256k auto-compaction models", () => {
		it("matches Claude 4.6 and OpenAI GPT models", () => {
			expect(isTargetedAutoCompactionModel({ provider: "anthropic", id: "claude-sonnet-4-6" } as never)).toBe(true);
			expect(isTargetedAutoCompactionModel({ provider: "anthropic", id: "claude-opus-4-6" } as never)).toBe(true);
			expect(isTargetedAutoCompactionModel({ provider: "openai", id: "gpt-5.4" } as never)).toBe(true);
			expect(isTargetedAutoCompactionModel({ provider: "anthropic", id: "claude-sonnet-4-5" } as never)).toBe(false);
		});

		it("forces auto-compaction even when autohandoff mode is off", () => {
			expect(
				shouldAutoCompactForModel({
					autoHandoffMode: "off",
					model: { provider: "anthropic", id: "claude-sonnet-4-6" } as never,
				}),
			).toBe(true);
			expect(
				shouldAutoCompactForModel({
					autoHandoffMode: "off",
					model: { provider: "anthropic", id: "claude-sonnet-4-5" } as never,
				}),
			).toBe(false);
		});

		it("caps targeted models at a 256k effective context window", () => {
			expect(
				getAutoCompactionContextWindow({
					provider: "anthropic",
					id: "claude-sonnet-4-6",
					contextWindow: 1_000_000,
				} as never),
			).toBe(256000);
			expect(
				getAutoCompactionContextWindow({ provider: "openai", id: "gpt-5.4", contextWindow: 400_000 } as never),
			).toBe(256000);
			expect(
				getAutoCompactionContextWindow({
					provider: "anthropic",
					id: "claude-sonnet-4-5",
					contextWindow: 200_000,
				} as never),
			).toBe(200000);
		});
	});

	describe("shouldTriggerEmergencyAutoHandoff", () => {
		it("does not trigger when mode=off", () => {
			expect(
				shouldTriggerEmergencyAutoHandoff({
					autoHandoffMode: "off",
					ratio: 0.99,
					hasModel: true,
					isAutoHandoffInProgress: false,
					stopReason: "toolUse",
				}),
			).toBe(false);
		});

		it("triggers when mode=on at 95% and stopReason=toolUse", () => {
			expect(
				shouldTriggerEmergencyAutoHandoff({
					autoHandoffMode: "on",
					ratio: 0.95,
					hasModel: true,
					isAutoHandoffInProgress: false,
					stopReason: "toolUse",
				}),
			).toBe(true);
		});

		it("does not trigger when stopReason!=toolUse", () => {
			expect(
				shouldTriggerEmergencyAutoHandoff({
					autoHandoffMode: "on",
					ratio: 0.99,
					hasModel: true,
					isAutoHandoffInProgress: false,
					stopReason: "stop",
				}),
			).toBe(false);
		});
	});

	describe("shouldTriggerStandardAutoHandoff", () => {
		it("triggers when mode=on at 90% after a completed turn", () => {
			expect(
				shouldTriggerStandardAutoHandoff({
					autoHandoffMode: "on",
					ratio: 0.9,
					hasModel: true,
					isAutoHandoffInProgress: false,
				}),
			).toBe(true);
		});

		it("does not trigger below 90%", () => {
			expect(
				shouldTriggerStandardAutoHandoff({
					autoHandoffMode: "on",
					ratio: 0.89,
					hasModel: true,
					isAutoHandoffInProgress: false,
				}),
			).toBe(false);
		});
	});

	describe("shouldEnableHandoffNudge", () => {
		it("does not enable nudge when mode=off", () => {
			expect(shouldEnableHandoffNudge({ autoHandoffMode: "off", ratio: 0.99, currentFlag: false })).toBe(false);
		});

		it("enables nudge as a one-way latch when mode=on", () => {
			expect(shouldEnableHandoffNudge({ autoHandoffMode: "on", ratio: 0.8, currentFlag: false })).toBe(true);
			expect(shouldEnableHandoffNudge({ autoHandoffMode: "on", ratio: 0.0, currentFlag: true })).toBe(true);
		});
	});
});
