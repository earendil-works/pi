import type { AgentState } from "@kennyfrc/mu-agent-core";
import { visibleWidth } from "@kennyfrc/mu-tui";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { FooterComponent } from "./footer.js";

initTheme("dark");

function createState(): AgentState {
	return {
		systemPrompt: "",
		model: {
			id: "gpt-5.4",
			name: "GPT-5.4",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai-codex",
			api: "openai-responses",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 32000,
		},
		thinkingLevel: "medium",
		fastMode: false,
		tools: [],
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
	};
}

describe("FooterComponent", () => {
	it("renders the active footer as two rows with working left/title right and status left/path right", () => {
		const footer = new FooterComponent(createState());
		footer.setTitle("Investigate footer layout overflow");
		footer.setTransientStatus({
			indicator: "⣠",
			message: "Working (9s • 21 tps • 2.3s lat. • esc to interrupt)",
		});

		const lines = footer.render(100).map((line) => stripAnsi(line));

		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("Working (9s • 21 tps • 2.3s lat. • esc to interrupt)");
		expect(lines[0]).toContain("Investigate footer layout overflow");
		expect(lines[1]).toContain("gpt-5.4 • medium [openai-codex]");
		expect(lines[1]).toContain("pi-mono");
	});

	it("keeps both footer rows within the available width", () => {
		const footer = new FooterComponent(createState());
		footer.setTitle("A very long footer title that should be truncated before it collides with the working status");
		footer.setTransientStatus({
			indicator: "⣠",
			message: "Working (999s • 999 tps • 99.9s lat. • esc to interrupt)",
		});

		const width = 56;
		const lines = footer.render(width).map((line) => stripAnsi(line));

		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
