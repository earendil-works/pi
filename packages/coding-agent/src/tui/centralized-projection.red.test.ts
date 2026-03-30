import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { InlineToolOverlayComponent } from "./inline-tool-overlay.js";
import { ToolExecutionComponent } from "./tool-execution.js";

function renderToolText(component: ToolExecutionComponent, width: number): string {
	return stripAnsi(component.render(width).join("\n"));
}

function renderInlineText(component: InlineToolOverlayComponent, width: number): string {
	return stripAnsi(component.render(width).join("\n"));
}

describe("centralized projection red suite", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	it("renders transcript output from details.projection instead of mu_display fallbacks", () => {
		const component = new ToolExecutionComponent("fetch", {
			argv: ["https://example.com/search?q=projection"],
		});

		component.updateResult({
			content: [{ type: "text", text: "result one\nresult two" }],
			isError: false,
			details: {
				projection: {
					version: 1,
					kind: "tool_panel",
					intent: { preferredSurface: "transcript" },
					state: {
						title: "Search Results",
						summary: "2 matches",
						items: ["result one", "result two"],
					},
					transcript: { mode: "derive" },
				},
			},
		});

		const text = renderToolText(component, 120);
		expect(text).toContain("Search Results");
		expect(text).toContain("2 matches");
	});

	it("renders generic inline projection chrome instead of todo-specific chrome", () => {
		const component = new InlineToolOverlayComponent("web_search", {
			query: "projection system",
		});

		component.updateResult({
			content: [{ type: "text", text: "Projection docs\nProjection repo" }],
			isError: false,
			details: {
				projection: {
					version: 1,
					kind: "tool_panel",
					intent: { preferredSurface: "inline" },
					state: {
						title: "Search Results",
						summary: "2 matches",
						items: ["Projection docs", "Projection repo"],
					},
				},
			},
		});

		const text = renderInlineText(component, 80);
		expect(text).toContain("Search Results");
		expect(text).not.toContain("Todo List");
	});
});
