import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CompactionSelectorComponent } from "../src/modes/interactive/components/compaction-selector.ts";
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

const nextModel: Model<"anthropic-messages"> = {
	...model,
	id: "next-summary-model",
	name: "Next Summary Model",
};

describe("compaction selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("shows compaction choices and the temporary summary configuration", () => {
		const selector = new CompactionSelectorComponent(
			model,
			"high",
			vi.fn(),
			vi.fn(),
			vi.fn(),
			vi.fn(),
			vi.fn(),
			vi.fn(),
		);

		const lines = selector.render(100);
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("Compact context?");
		expect(rendered).toContain("Compact with custom prompt");
		expect(rendered).toContain("Cancel");
		expect(rendered).toContain("Using: anthropic/summary-model • high");
		expect(lines[0]).toBe(theme.getThinkingBorderColor("high")("─".repeat(100)));
		expect(lines.at(-1)).toBe(theme.getThinkingBorderColor("high")("─".repeat(100)));
		expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
	});

	it("selects compact by default", () => {
		const onSelect = vi.fn();
		const selector = new CompactionSelectorComponent(
			model,
			"off",
			onSelect,
			vi.fn(),
			vi.fn(),
			vi.fn(),
			vi.fn(),
			vi.fn(),
		);

		selector.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith("Compact");
	});

	it("cycles thinking locally and exposes temporary model controls", () => {
		const onSelectModel = vi.fn();
		const onCycleModel = vi.fn(() => ({ model: nextModel, thinkingLevel: "high" as const }));
		const levels: ThinkingLevel[] = [];
		const selector = new CompactionSelectorComponent(
			model,
			"low",
			vi.fn(),
			onSelectModel,
			onCycleModel,
			(level) => levels.push(level),
			vi.fn(),
			vi.fn(),
		);

		selector.handleInput("\x1b[Z");
		selector.handleInput("\x0c");
		selector.handleInput("\x10");

		expect(levels).toEqual(["medium"]);
		expect(onSelectModel).toHaveBeenCalledOnce();
		expect(onCycleModel).toHaveBeenCalledWith("forward");
		expect(stripAnsi(selector.render(100).join("\n"))).toContain("Using: anthropic/next-summary-model • high");
	});
});
