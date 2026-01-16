import type { ThinkingLevel } from "@kennyfrc/pi-agent-core";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme, theme } from "../src/theme/theme.js";
import {
	getEffectiveThinkingLevel,
	getNextThinkingLevel,
	getPreviousThinkingLevel,
	getTabThinkingLevels,
	getThinkingLevelItems,
} from "../src/tui/thinking-levels.js";

beforeAll(() => {
	initTheme("dark");
});

describe("thinking level utilities", () => {
	it("includes xhigh in selector items when supported", () => {
		const items = getThinkingLevelItems(true).map((item) => item.value);
		expect(items).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
	});

	it("excludes xhigh in selector items when unsupported", () => {
		const items = getThinkingLevelItems(false).map((item) => item.value);
		expect(items).toEqual(["off", "minimal", "low", "medium", "high"]);
	});

	it("cycles tab thinking levels with and without xhigh", () => {
		const cycleWithXhigh = getTabThinkingLevels(true);
		expect(cycleWithXhigh).toEqual(["off", "low", "medium", "high", "xhigh"]);

		const cycleWithoutXhigh = getTabThinkingLevels(false);
		expect(cycleWithoutXhigh).toEqual(["off", "low", "medium", "high"]);
	});

	it("computes next thinking level based on support", () => {
		const levels: Array<[ThinkingLevel, boolean, ThinkingLevel]> = [
			["off", true, "low"],
			["high", true, "xhigh"],
			["xhigh", true, "off"],
			["minimal", true, "low"],
			["high", false, "off"],
			["xhigh", false, "low"],
		];

		for (const [current, supportsXhigh, expected] of levels) {
			expect(getNextThinkingLevel(current, supportsXhigh)).toBe(expected);
		}
	});

	it("computes previous thinking level based on support", () => {
		const levels: Array<[ThinkingLevel, boolean, ThinkingLevel]> = [
			["off", true, "xhigh"],
			["low", true, "off"],
			["medium", true, "low"],
			["high", true, "medium"],
			["minimal", true, "off"],
			["off", false, "high"],
			["high", false, "medium"],
			["xhigh", false, "high"],
		];

		for (const [current, supportsXhigh, expected] of levels) {
			expect(getPreviousThinkingLevel(current, supportsXhigh)).toBe(expected);
		}
	});

	it("clamps thinking level based on model support", () => {
		const levels: Array<[ThinkingLevel, boolean, boolean, ThinkingLevel]> = [
			["xhigh", true, true, "xhigh"],
			["xhigh", true, false, "high"],
			["high", true, false, "high"],
			["low", false, false, "off"],
		];

		for (const [current, supportsReasoning, supportsXhigh, expected] of levels) {
			expect(getEffectiveThinkingLevel(current, supportsReasoning, supportsXhigh)).toBe(expected);
		}
	});

	it("maps xhigh border color to thinkingXhigh token", () => {
		const color = theme.getThinkingBorderColor("xhigh");
		expect(color("test")).toBe(theme.fg("thinkingXhigh", "test"));
	});
});
