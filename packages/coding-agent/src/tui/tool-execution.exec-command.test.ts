import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { ToolExecutionComponent } from "./tool-execution.js";

function renderText(component: ToolExecutionComponent, width: number): string {
	return stripAnsi(component.render(width).join("\n"));
}

describe("ToolExecutionComponent exec_command rendering", () => {
	initTheme("dark");

	it("renders a concise call header (no JSON args dump)", () => {
		const component = new ToolExecutionComponent("exec_command", {
			cmd: "nl -ba packages/coding-agent/src/tui/tool-execution.ts",
			workdir: "/tmp",
		});

		const text = renderText(component, 80);
		expect(text).toContain("exec_command");
		expect(text).toContain("nl -ba");
		// The old behavior dumped raw JSON args. This should not.
		expect(text).not.toContain('"cmd"');
		expect(text).not.toContain('"workdir"');
	});

	it("shows multi-line commands (not truncated to the first line)", () => {
		const component = new ToolExecutionComponent("exec_command", {
			cmd: ["websearch --batch \\\\", "  Query: one", "  Query: two", "  --limit 5"].join("\n"),
		});

		const text = renderText(component, 120);
		expect(text).toContain("websearch --batch");
		expect(text).toContain("Query: one");
		expect(text).toContain("Query: two");
		expect(text).toContain("--limit 5");
	});

	it("normalizes legacy tool names to snake_case", () => {
		const component = new ToolExecutionComponent("Exec", {
			cmd: "echo hi",
		});

		const text = renderText(component, 80);
		expect(text).toContain("exec_command");
	});

	it("shows collapsed output preview + ctrl+o hint for huge output", () => {
		const component = new ToolExecutionComponent("exec_command", {
			cmd: "echo huge",
		});
		component.updateResult({
			content: [{ type: "text", text: "A".repeat(32 * 1024) }],
			isError: false,
		});

		const lines = component.render(100);
		const text = stripAnsi(lines.join("\n"));

		// Same bound as the Bash visual-truncate regression test.
		expect(lines.length).toBeLessThanOrEqual(24);
		expect(text).toContain("ctrl+o to expand");
	});

	it("renders streaming partial output before final result", () => {
		const component = new ToolExecutionComponent("exec_command", {
			cmd: "echo hi",
		});
		component.appendOutput("hello\nworld\n");

		const text = renderText(component, 80);
		expect(text).toContain("hello");
		expect(text).toContain("world");
	});
});
