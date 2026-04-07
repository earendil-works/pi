/**
 * Auto-handoff policy gating
 *
 * Auto-compaction is ON by default for all models.
 * Users can disable it with /autohandoff off.
 */

import { describe, expect, it } from "vitest";

import {
	AUTO_COMPACTION_CONTEXT_WINDOW_CAP,
	AUTO_HANDOFF_EMERGENCY_THRESHOLD,
	AUTO_HANDOFF_STANDARD_THRESHOLD,
	getAutoCompactionContextWindow,
	shouldAutoCompactForModel,
	shouldEnableHandoffNudge,
	shouldTriggerEmergencyAutoHandoff,
	shouldTriggerStandardAutoHandoff,
} from "../src/auto-handoff.js";

describe("Auto-handoff policy", () => {
	it("uses expected thresholds", () => {
		expect(AUTO_HANDOFF_EMERGENCY_THRESHOLD).toBe(0.95);
		expect(AUTO_HANDOFF_STANDARD_THRESHOLD).toBe(0.9);
	});

	it("uses 256k context window cap", () => {
		expect(AUTO_COMPACTION_CONTEXT_WINDOW_CAP).toBe(256000);
	});

	describe("shouldAutoCompactForModel", () => {
		it("returns true when autoHandoffMode is on", () => {
			expect(shouldAutoCompactForModel({ autoHandoffMode: "on" })).toBe(true);
		});

		it("returns false when autoHandoffMode is off (user disabled)", () => {
			expect(shouldAutoCompactForModel({ autoHandoffMode: "off" })).toBe(false);
		});

		it("works for all models - no targeted model concept", () => {
			// All models should have auto-compaction by default
			expect(shouldAutoCompactForModel({ autoHandoffMode: "on" })).toBe(true);
		});
	});

	describe("getAutoCompactionContextWindow", () => {
		it("returns 0 for null/undefined model", () => {
			expect(getAutoCompactionContextWindow(null)).toBe(0);
			expect(getAutoCompactionContextWindow(undefined)).toBe(0);
		});

		it("caps models with large context windows at 256k", () => {
			expect(
				getAutoCompactionContextWindow({
					contextWindow: 1_000_000,
				} as never),
			).toBe(256000);
			expect(
				getAutoCompactionContextWindow({
					contextWindow: 400_000,
				} as never),
			).toBe(256000);
		});

		it("uses actual context window for models <= 256k", () => {
			expect(
				getAutoCompactionContextWindow({
					contextWindow: 200_000,
				} as never),
			).toBe(200000);
			expect(
				getAutoCompactionContextWindow({
					contextWindow: 128_000,
				} as never),
			).toBe(128000);
			expect(
				getAutoCompactionContextWindow({
					contextWindow: 64_000,
				} as never),
			).toBe(64000);
		});

		it("works for all providers - no targeted model concept", () => {
			// Gemini 1M context -> capped at 256k
			expect(
				getAutoCompactionContextWindow({
					provider: "google",
					id: "gemini-2.0-flash",
					contextWindow: 1_000_000,
				} as never),
			).toBe(256000);

			// Kimi 1M context -> capped at 256k
			expect(
				getAutoCompactionContextWindow({
					provider: "moonshotai",
					id: "kimi-k2-0905",
					contextWindow: 1_000_000,
				} as never),
			).toBe(256000);

			// DeepSeek 64k context -> uses actual
			expect(
				getAutoCompactionContextWindow({
					provider: "deepseek",
					id: "deepseek-chat",
					contextWindow: 64_000,
				} as never),
			).toBe(64000);
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
