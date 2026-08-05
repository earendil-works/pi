import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { BranchSummarySelectorComponent } from "../src/modes/interactive/components/branch-summary-selector.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const model: Model<"anthropic-messages"> = {
	id: "summary-model",
	name: "Summary Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
};

describe("branch summary selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("shows the temporary summary model, thinking level, and controls", () => {
		const selector = new BranchSummarySelectorComponent(model, "low", vi.fn(), vi.fn(), vi.fn(), vi.fn());

		const lines = selector.render(100);
		const renderedLines = stripAnsi(lines.join("\n")).split("\n");
		const summaryConfig = "summarize with: (anthropic) summary-model • low";
		const summaryConfigIndex = renderedLines.findIndex((line) => line.includes(summaryConfig));
		expect(summaryConfigIndex).toBe(renderedLines.length - 2);
		expect(summaryConfigIndex).toBeGreaterThan(
			renderedLines.findIndex((line) => line.includes("shift+tab thinking")),
		);
		expect(lines.join("\n")).toContain(theme.getThinkingBorderColor("low")("low"));
		expect(lines[0]).toBe(theme.getThinkingBorderColor("low")("─".repeat(100)));
		expect(lines.at(-1)).toBe(theme.getThinkingBorderColor("low")("─".repeat(100)));
		expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
	});

	it("matches the footer wording when thinking is off", () => {
		const selector = new BranchSummarySelectorComponent(model, "off", vi.fn(), vi.fn(), vi.fn(), vi.fn());

		expect(stripAnsi(selector.render(100).join("\n"))).toContain(
			"summarize with: (anthropic) summary-model • thinking off",
		);
	});

	it("cycles thinking locally and opens temporary model selection", () => {
		const onSelectModel = vi.fn();
		const levels: ThinkingLevel[] = [];
		const selector = new BranchSummarySelectorComponent(
			model,
			"low",
			vi.fn(),
			onSelectModel,
			(level) => levels.push(level),
			vi.fn(),
		);

		selector.handleInput("\x1b[Z");
		selector.handleInput("\x0c");

		expect(levels).toEqual(["medium"]);
		expect(onSelectModel).toHaveBeenCalledOnce();
		const lines = selector.render(100);
		expect(stripAnsi(lines.join("\n"))).toContain("summarize with: (anthropic) summary-model • medium");
		expect(lines[0]).toBe(theme.getThinkingBorderColor("medium")("─".repeat(100)));
		expect(lines.at(-1)).toBe(theme.getThinkingBorderColor("medium")("─".repeat(100)));
	});
});
