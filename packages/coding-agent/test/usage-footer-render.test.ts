import type { AgentState } from "@kennyfrc/mu-agent-core";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { initTheme } from "../src/theme/theme.js";
import { FooterComponent } from "../src/tui/footer.js";

function createState(): AgentState {
	return {
		systemPrompt: "test",
		model: {
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark (ChatGPT Sub)",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 32000,
		},
		thinkingLevel: "medium",
		fastMode: false,
		tools: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
		messages: [
			{
				role: "assistant",
				api: "openai-codex-responses",
				provider: "openai-codex",
				model: "gpt-5.3-codex-spark",
				timestamp: 1,
				stopReason: "stop",
				content: [],
				usage: {
					input: 1000,
					output: 900,
					cacheRead: 350,
					cacheWrite: 0,
					totalTokens: 2250,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		],
	};
}

describe("Footer usage-limit rendering", () => {
	initTheme("dark");

	it("shows fast only when fast mode is enabled", () => {
		const enabledState = createState();
		enabledState.fastMode = true;
		const enabledFooter = new FooterComponent(enabledState);
		const enabledText = stripAnsi(enabledFooter.render(140).join("\n"));
		expect(enabledText).toContain("• fast [openai-codex]");
		expect(enabledText).not.toContain("fast:on");
		expect(enabledText).not.toContain("fast:off");

		const disabledFooter = new FooterComponent(createState());
		const disabledText = stripAnsi(disabledFooter.render(140).join("\n"));
		expect(disabledText).not.toContain("fast");
	});

	it("renders short-window and weekly usage when footer usage is enabled", () => {
		const footer = new FooterComponent(createState());
		(footer as any).setUsageFooterMode("visible");
		(footer as any).setUsageLimits({
			capturedAt: Date.now(),
			primary: { label: "5h", percentRemaining: 28, resetsAt: "03:14" },
			secondary: { label: "weekly", percentRemaining: 60, resetsAt: "03:34" },
		});

		const text = stripAnsi(footer.render(140).join("\n"));
		expect(text).toContain("5h 28%");
		expect(text).toContain("weekly 60%");
		expect(text).not.toContain("ctx ");
		expect(text).not.toContain("↑");
		expect(text).not.toContain("↓");
		expect(text).not.toContain("R350");
	});

	it("hides usage-limit chips when footer usage is hidden", () => {
		const footer = new FooterComponent(createState());
		(footer as any).setUsageFooterMode("hidden");
		(footer as any).setUsageLimits({
			capturedAt: Date.now(),
			primary: { label: "5h", percentRemaining: 28, resetsAt: "03:14" },
			secondary: { label: "weekly", percentRemaining: 60, resetsAt: "03:34" },
		});

		const text = stripAnsi(footer.render(140).join("\n"));
		expect(text).not.toContain("5h 28%");
		expect(text).not.toContain("weekly 60%");
		expect(text).not.toContain("ctx ");
		expect(text).not.toContain("↑");
		expect(text).not.toContain("↓");
	});
});
