import { describe, expect, it } from "vitest";
import { initTheme, theme } from "../theme/theme.js";
import { ToolExecutionComponent } from "./tool-execution.js";

function renderRaw(component: ToolExecutionComponent, width: number): string {
	return component.render(width).join("\n");
}

describe("ToolExecutionComponent non-shell tool highlighting", () => {
	initTheme("nerv");

	it("renders read paths and line suffixes with nerv syntax colors instead of one flat accent", () => {
		const component = new ToolExecutionComponent("read", {
			path: "/Users/kennyfrc/Documents/code/work/pi-mono/packages/coding-agent/src/tui/tool-execution.ts",
			offset: 42,
			limit: 12,
		});

		const rendered = renderRaw(component, 180);

		expect(rendered).toContain(theme.getFgAnsi("syntaxString"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxPunctuation"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxNumber"));
		expect(rendered).not.toContain(
			theme.getFgAnsi("accent") + "~/Documents/code/work/pi-mono/packages/coding-agent/src/tui/tool-execution.ts",
		);
	});

	it("renders write paths and line counts with nerv syntax colors", () => {
		const component = new ToolExecutionComponent("write", {
			path: "/tmp/example.ts",
			content: "const value = 1;\nconsole.log(value);\nexport { value };",
		});

		const rendered = renderRaw(component, 120);

		expect(rendered).toContain(theme.getFgAnsi("syntaxString"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxPunctuation"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxNumber"));
	});

	it("renders grep patterns, paths, and numeric limits with nerv syntax colors", () => {
		const component = new ToolExecutionComponent("grep", {
			pattern: "exec_command|bash",
			path: "packages/coding-agent/src",
			glob: "*.ts",
			limit: 5,
		});

		const rendered = renderRaw(component, 160);

		expect(rendered).toContain(theme.getFgAnsi("syntaxString"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxPunctuation"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxNumber"));
		expect(rendered).not.toContain(theme.getFgAnsi("accent") + "/exec_command|bash/");
	});

	it("renders glob patterns and paths with nerv syntax colors", () => {
		const component = new ToolExecutionComponent("glob", {
			pattern: "**/*.test.ts",
			path: "packages/coding-agent",
			limit: 10,
		});

		const rendered = renderRaw(component, 140);

		expect(rendered).toContain(theme.getFgAnsi("syntaxString"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxPunctuation"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxNumber"));
	});
});
