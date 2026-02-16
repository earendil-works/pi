import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { ToolExecutionComponent } from "./tool-execution.js";

function renderText(component: ToolExecutionComponent, width: number): string {
	return stripAnsi(component.render(width).join("\n"));
}

describe("ToolExecutionComponent mu_display rendering", () => {
	initTheme("dark");

	it("renders mu_display.call.text instead of dumping JSON args", () => {
		const component = new ToolExecutionComponent("fetch", {
			argv: ["https://example.com", "--max-length", "200"],
		});

		component.updateResult({
			content: [{ type: "text", text: "hello" }],
			isError: false,
			details: {
				mu_display: {
					version: 1,
					call: {
						style: "argv",
						text: "webfetch https://example.com --max-length 200",
						command: "webfetch",
						argv: ["https://example.com", "--max-length", "200"],
					},
					summary: { text: "ok · exit=0" },
					output: { collapse: { maxVisualLines: 5, expandHint: "ctrl+o to expand" } },
				},
			},
		});

		const text = renderText(component, 120);
		expect(text).toContain("webfetch https://example.com --max-length 200");
		expect(text).toContain("ok · exit=0");
		expect(text).not.toContain('"argv"');
	});

	it("collapses long output using mu_display.output.collapse", () => {
		const component = new ToolExecutionComponent("web_search", {
			argv: ["hello"],
		});

		const longText = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n");

		component.updateResult({
			content: [{ type: "text", text: longText }],
			isError: false,
			details: {
				mu_display: {
					version: 1,
					call: { style: "argv", text: "websearch query hello", command: "websearch", argv: ["query", "hello"] },
					output: { collapse: { maxVisualLines: 5, expandHint: "ctrl+o to expand" } },
				},
			},
		});

		const lines = component.render(100);
		const text = stripAnsi(lines.join("\n"));

		expect(lines.length).toBeLessThanOrEqual(24);
		expect(text).toContain("ctrl+o to expand");
	});

	it("renders a CLI-like call line for fetch args before mu_display is available", () => {
		const component = new ToolExecutionComponent("fetch", {
			url: "https://example.com",
			browser: true,
			maxLength: 200,
		});

		const text = renderText(component, 120);
		expect(text).toContain("webfetch https://example.com --browser --max-length 200");
		expect(text).not.toContain('"url"');
	});

	it("renders a CLI-like call line for web_search args before mu_display is available", () => {
		const component = new ToolExecutionComponent("web_search", {
			searchTerm: "hello",
			country: "US",
			count: 3,
		});

		const text = renderText(component, 120);
		expect(text).toContain("websearch query hello --country US --count 3");
		expect(text).not.toContain('"searchTerm"');
	});

	it("renders streaming partial output for argv-style tools before final result", () => {
		const component = new ToolExecutionComponent("fetch", {
			argv: ["https://example.com"],
		});

		component.appendOutput("downloading...\n");

		const text = renderText(component, 80);
		expect(text).toContain("downloading...");
	});
});
