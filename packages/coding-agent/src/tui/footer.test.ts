import type { AgentState } from "@kennyfrc/mu-agent-core";
import { visibleWidth } from "@kennyfrc/mu-tui";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { initTheme, theme } from "../theme/theme.js";
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
	it("renders the active footer as two rows with working duration on the first row and live stats on the second", () => {
		const footer = new FooterComponent(createState());
		footer.setTitle("Investigate footer layout overflow");
		footer.setTransientStatus({
			indicator: "░▒▓█   ",
			message: "Working (9s • 21 tps • 2.3s lat. • esc to interrupt)",
		});

		const lines = footer.render(120).map((line) => stripAnsi(line));

		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("Working • 9s");
		expect(lines[0]).toContain("Investigate footer layout overflow");
		expect(lines[1]).toContain("21 tps • 2.3s lat. • esc to interrupt");
		expect(lines[1]).toContain("pi-mono");
	});

	it("keeps the second working row compact when latency is unavailable", () => {
		const footer = new FooterComponent(createState());
		footer.setTransientStatus({
			indicator: "░▒▓█   ",
			message: "Working (9s • 21 tps • esc to interrupt)",
		});

		const lines = footer.render(100).map((line) => stripAnsi(line));

		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("Working • 9s");
		expect(lines[1]).toContain("21 tps • esc to interrupt");
	});

	it("keeps both footer rows within the available width", () => {
		const footer = new FooterComponent(createState());
		footer.setTitle("A very long footer title that should be truncated before it collides with the working status");
		footer.setTransientStatus({
			indicator: "░▒▓█   ",
			message: "Working (999s • 999 tps • 99.9s lat. • esc to interrupt)",
		});

		const width = 56;
		const lines = footer.render(width).map((line) => stripAnsi(line));

		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("uses the active thinking border color for the working indicator", () => {
		const footer = new FooterComponent(createState());
		footer.setTransientStatus({
			indicator: "░▒▓█   ",
			message: "Working (9s • 21 tps • esc to interrupt)",
		});

		const rendered = footer.render(100)[0] ?? "";
		const expectedColor = theme.getFgAnsi(theme.getThinkingBorderThemeColor("medium"));

		expect(rendered).toContain(`\x1b[2m${expectedColor}░\x1b[22m\x1b[39m`);
		expect(rendered).toContain(`\x1b[2m${expectedColor}▒\x1b[22m\x1b[39m`);
		expect(rendered).toContain(`${expectedColor}▓\x1b[39m`);
		expect(rendered).toContain(`\x1b[1m${expectedColor}█\x1b[22m\x1b[39m`);
		expect(rendered).not.toContain(`${theme.getFgAnsi("accent")}▓\x1b[39m`);
		expect(rendered).not.toContain(`${theme.getFgAnsi("muted")}▒\x1b[39m`);
		expect(rendered).not.toContain(`${theme.getFgAnsi("dim")}░\x1b[39m`);
	});

	it("keeps the title right-aligned when idle after working state clears", () => {
		const footer = new FooterComponent(createState());
		footer.setTitle("Investigate footer layout overflow");
		footer.setTransientStatus({
			indicator: "░▒▓█   ",
			message: "Working (9s • 21 tps • 2.3s lat. • esc to interrupt)",
		});

		footer.setTransientStatus(null);

		const lines = footer.render(100).map((line) => stripAnsi(line));

		expect(lines).toHaveLength(2);
		expect(lines[0].trimStart()).toBe("Investigate footer layout overflow");
		expect(lines[0].endsWith("Investigate footer layout overflow")).toBe(true);
		expect(lines[0].startsWith(" ")).toBe(true);
		expect(lines[1]).toContain("pi-mono");
	});

	it("renders the Ctrl+C exit hint only on the second footer row", () => {
		const footer = new FooterComponent(createState());
		footer.setTitle("Investigate footer layout overflow");
		footer.setShowExitHint(true);

		const lines = footer.render(100).map((line) => stripAnsi(line));
		const hint = "Press Ctrl+C again to exit";
		const hintCount = lines.reduce((total, line) => total + line.split(hint).length - 1, 0);

		expect(lines).toHaveLength(2);
		expect(lines[0]).not.toContain(hint);
		expect(lines[1]).toContain(hint);
		expect(hintCount).toBe(1);
	});
});
