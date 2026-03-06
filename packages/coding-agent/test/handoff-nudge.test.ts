/**
 * Handoff Nudge Tests
 *
 * Tests the 80% threshold nudge system that encourages voluntary handoff
 * before forced auto-handoff at 95%.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getHandoffNudgeReminder, HANDOFF_NUDGE_THRESHOLD } from "../src/prompts/index.js";

describe("Handoff Nudge", () => {
	describe("Constants", () => {
		it("threshold is 80%", () => {
			expect(HANDOFF_NUDGE_THRESHOLD).toBe(0.8);
		});
	});

	describe("getHandoffNudgeReminder", () => {
		it("returns a string containing system_reminder tags", () => {
			const reminder = getHandoffNudgeReminder(0.85);
			expect(reminder).toContain("<system_reminder>");
			expect(reminder).toContain("</system_reminder>");
		});

		it("shows the actual context percentage", () => {
			expect(getHandoffNudgeReminder(0.8)).toContain("80%");
			expect(getHandoffNudgeReminder(0.85)).toContain("85%");
			expect(getHandoffNudgeReminder(0.92)).toContain("92%");
		});

		it("mentions compact", () => {
			const reminder = getHandoffNudgeReminder(0.85);
			expect(reminder).toContain("compact");
		});

		it("mentions 95% auto-handoff", () => {
			const reminder = getHandoffNudgeReminder(0.85);
			expect(reminder).toContain("95%");
		});
	});
});

describe("Threshold Detection Logic", () => {
	// Extract threshold detection logic for unit testing
	// This mirrors the logic in tui-renderer.ts

	function shouldSetNudgeFlag(ratio: number, currentFlag: boolean): boolean {
		// One-way latch: once set, stays set
		if (currentFlag) return true;
		return ratio >= HANDOFF_NUDGE_THRESHOLD;
	}

	describe("shouldSetNudgeFlag", () => {
		it("returns false when ratio < 0.80 and flag is false", () => {
			expect(shouldSetNudgeFlag(0.79, false)).toBe(false);
			expect(shouldSetNudgeFlag(0.5, false)).toBe(false);
			expect(shouldSetNudgeFlag(0.0, false)).toBe(false);
		});

		it("returns true when ratio >= 0.80 and flag is false", () => {
			expect(shouldSetNudgeFlag(0.8, false)).toBe(true);
			expect(shouldSetNudgeFlag(0.81, false)).toBe(true);
			expect(shouldSetNudgeFlag(0.9, false)).toBe(true);
			expect(shouldSetNudgeFlag(0.99, false)).toBe(true);
		});

		it("returns true when flag is already true (one-way latch)", () => {
			expect(shouldSetNudgeFlag(0.5, true)).toBe(true);
			expect(shouldSetNudgeFlag(0.79, true)).toBe(true);
			expect(shouldSetNudgeFlag(0.8, true)).toBe(true);
		});

		it("boundary: exactly 0.80 triggers", () => {
			expect(shouldSetNudgeFlag(0.8, false)).toBe(true);
		});

		it("boundary: 0.7999... does not trigger", () => {
			expect(shouldSetNudgeFlag(0.7999999, false)).toBe(false);
		});
	});
});

describe("Message Augmentation Logic", () => {
	function augmentMessage(text: string, shouldNudge: boolean, ratio = 0.85): string {
		if (!shouldNudge) return text;
		return text + getHandoffNudgeReminder(ratio);
	}

	it("returns original text when shouldNudge is false", () => {
		const original = "Hello, please help me with this code";
		expect(augmentMessage(original, false)).toBe(original);
	});

	it("appends reminder when shouldNudge is true", () => {
		const original = "Hello, please help me with this code";
		const result = augmentMessage(original, true);
		expect(result).toContain(original);
		expect(result).toContain("<system_reminder>");
		expect(result.indexOf(original)).toBe(0); // Original is at start
	});

	it("preserves original text exactly at start", () => {
		const original = "Special chars: <>&\"'";
		const result = augmentMessage(original, true);
		expect(result.startsWith(original)).toBe(true);
	});

	it("handles empty text", () => {
		const result = augmentMessage("", true);
		expect(result).toContain("<system_reminder>");
	});

	it("handles multiline text", () => {
		const original = "Line 1\nLine 2\nLine 3";
		const result = augmentMessage(original, true);
		expect(result).toContain(original);
		expect(result).toContain("<system_reminder>");
	});
});

describe("Nudge State Machine", () => {
	/**
	 * Simulates the TuiRenderer's nudge state management.
	 * This mirrors the logic in tui-renderer.ts without requiring TUI dependencies.
	 */
	class NudgeStateMachine {
		private shouldIncludeHandoffNudge = false;
		private lastRatio = 0;

		/** Called after agent_end with current context ratio */
		onAgentEnd(ratio: number): void {
			this.lastRatio = ratio;
			if (!this.shouldIncludeHandoffNudge && ratio >= HANDOFF_NUDGE_THRESHOLD) {
				this.shouldIncludeHandoffNudge = true;
			}
		}

		/** Called on session init with existing context ratio */
		onSessionInit(ratio: number): void {
			this.lastRatio = ratio;
			if (ratio >= HANDOFF_NUDGE_THRESHOLD) {
				this.shouldIncludeHandoffNudge = true;
			}
		}

		/** Called on /clear, auto-handoff, or explicit handoff */
		onSessionReset(): void {
			this.shouldIncludeHandoffNudge = false;
			this.lastRatio = 0;
		}

		/** Get augmented message text */
		augmentMessage(text: string): string {
			if (!this.shouldIncludeHandoffNudge) return text;
			return text + getHandoffNudgeReminder(this.lastRatio);
		}

		/** For testing: check current state */
		isNudgeEnabled(): boolean {
			return this.shouldIncludeHandoffNudge;
		}
	}

	let machine: NudgeStateMachine;

	beforeEach(() => {
		machine = new NudgeStateMachine();
	});

	describe("Initial state", () => {
		it("starts with nudge disabled", () => {
			expect(machine.isNudgeEnabled()).toBe(false);
		});

		it("does not augment messages initially", () => {
			expect(machine.augmentMessage("test")).toBe("test");
		});
	});

	describe("Threshold crossing", () => {
		it("enables nudge when ratio crosses 80%", () => {
			machine.onAgentEnd(0.79);
			expect(machine.isNudgeEnabled()).toBe(false);

			machine.onAgentEnd(0.8);
			expect(machine.isNudgeEnabled()).toBe(true);
		});

		it("stays enabled once crossed (one-way latch)", () => {
			machine.onAgentEnd(0.8);
			expect(machine.isNudgeEnabled()).toBe(true);

			// Ratio drops but nudge stays on
			machine.onAgentEnd(0.7);
			expect(machine.isNudgeEnabled()).toBe(true);
		});

		it("augments messages after threshold crossed", () => {
			machine.onAgentEnd(0.8);
			const result = machine.augmentMessage("test");
			expect(result).toContain("test");
			expect(result).toContain("<system_reminder>");
		});
	});

	describe("Session reset", () => {
		it("disables nudge on reset", () => {
			machine.onAgentEnd(0.9);
			expect(machine.isNudgeEnabled()).toBe(true);

			machine.onSessionReset();
			expect(machine.isNudgeEnabled()).toBe(false);
		});

		it("stops augmenting after reset", () => {
			machine.onAgentEnd(0.9);
			machine.onSessionReset();
			expect(machine.augmentMessage("test")).toBe("test");
		});

		it("can re-enable after reset if threshold crossed again", () => {
			machine.onAgentEnd(0.9);
			machine.onSessionReset();
			expect(machine.isNudgeEnabled()).toBe(false);

			machine.onAgentEnd(0.86);
			expect(machine.isNudgeEnabled()).toBe(true);
		});
	});

	describe("Session resume (--continue)", () => {
		it("enables nudge if resumed session is above threshold", () => {
			machine.onSessionInit(0.87);
			expect(machine.isNudgeEnabled()).toBe(true);
		});

		it("does not enable nudge if resumed session is below threshold", () => {
			machine.onSessionInit(0.79);
			expect(machine.isNudgeEnabled()).toBe(false);
		});
	});

	describe("Edge cases", () => {
		it("handles exact boundary (0.80)", () => {
			machine.onAgentEnd(0.8);
			expect(machine.isNudgeEnabled()).toBe(true);
		});

		it("handles just below boundary (0.799999)", () => {
			machine.onAgentEnd(0.799999);
			expect(machine.isNudgeEnabled()).toBe(false);
		});

		it("handles zero ratio", () => {
			machine.onAgentEnd(0);
			expect(machine.isNudgeEnabled()).toBe(false);
		});

		it("handles ratio above 1.0 (edge case)", () => {
			machine.onAgentEnd(1.1);
			expect(machine.isNudgeEnabled()).toBe(true);
		});
	});
});
