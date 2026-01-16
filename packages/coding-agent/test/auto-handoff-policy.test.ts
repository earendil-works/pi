/**
 * Auto-handoff policy gating
 *
 * Auto-handoff must be disabled by default and only run when enabled.
 */

import { describe, expect, it } from "vitest";

import {
	AUTO_HANDOFF_EMERGENCY_THRESHOLD,
	shouldEnableHandoffNudge,
	shouldTriggerEmergencyAutoHandoff,
} from "../src/auto-handoff.js";

describe("Auto-handoff policy", () => {
	it("uses expected threshold", () => {
		expect(AUTO_HANDOFF_EMERGENCY_THRESHOLD).toBe(0.95);
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
