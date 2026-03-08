import { getModel } from "@kennyfrc/mu-ai";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { initTheme } from "../src/theme/theme.js";
import { formatComposerUsageLabel } from "../src/tui/composer-usage-label.js";
import type { UsageLimitsSnapshot } from "../src/usage-footer.js";

const usageLimits: UsageLimitsSnapshot = {
	capturedAt: Date.now(),
	primary: { label: "5h", percentRemaining: 75 },
	secondary: { label: "weekly", percentRemaining: 15 },
};

describe("formatComposerUsageLabel", () => {
	initTheme("dark");

	it("omits dollars for codex subscription models and shows context/quota summary", () => {
		const label = formatComposerUsageLabel({
			model: getModel("openai-codex", "gpt-5.1"),
			totalCost: 0,
			usageFooterMode: "visible",
			usageLimits,
			contextTokens: 27200,
			contextWindow: 272000,
		});

		expect(stripAnsi(label)).toBe("(sub) 10% of 272k↖5h 75%↖weekly 15%");
	});

	it("treats synthetic models as subscription-backed for display", () => {
		const label = formatComposerUsageLabel({
			model: getModel("synthetic", "hf:deepseek-ai/DeepSeek-V3-0324"),
			totalCost: 0,
			usageFooterMode: "visible",
			usageLimits,
			contextTokens: 6400,
			contextWindow: 64000,
		});

		expect(stripAnsi(label)).toBe("(sub) 10% of 64k↖5h 75%↖weekly 15%");
	});

	it("keeps dollar cost for api-backed models", () => {
		const label = formatComposerUsageLabel({
			model: getModel("openai", "gpt-4o-mini"),
			totalCost: 0.1234,
			usageFooterMode: "visible",
			usageLimits,
			contextTokens: 6400,
			contextWindow: 128000,
		});

		expect(stripAnsi(label)).toBe("$0.123 (api) 5% of 128k↖5h 75%↖weekly 15%");
	});

	it("renders separators in accent color", () => {
		const label = formatComposerUsageLabel({
			model: getModel("openai-codex", "gpt-5.1"),
			totalCost: 0,
			usageFooterMode: "visible",
			usageLimits,
			contextTokens: 27200,
			contextWindow: 272000,
		});

		expect(label).toContain("\x1b[38;2;120;220;232m↖");
	});
});
