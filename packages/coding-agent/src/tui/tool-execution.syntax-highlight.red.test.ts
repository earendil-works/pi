import { describe, expect, it } from "vitest";
import { initTheme, theme } from "../theme/theme.js";
import { ToolExecutionComponent } from "./tool-execution.js";

function renderRaw(component: ToolExecutionComponent, width: number): string {
	return component.render(width).join("\n");
}

describe("ToolExecutionComponent shell syntax highlighting", () => {
	initTheme("nerv");

	it("renders bash commands with nerv syntax colors for distinct shell token classes", () => {
		const component = new ToolExecutionComponent("bash", {
			command: 'printf "$HOME" | rg --color=never "exec_command" # shell comment',
		});

		const rendered = renderRaw(component, 160);

		expect(rendered).toContain(theme.getFgAnsi("syntaxFunction"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxVariable"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxString"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxOperator"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxComment"));
	});

	it("renders exec_command calls with the same nerv syntax colors instead of a single accent color", () => {
		const component = new ToolExecutionComponent("exec_command", {
			cmd: ['FOO=bar printf "$HOME" \\', '  | sed "s/foo/bar/" # transform'].join("\n"),
		});

		const rendered = renderRaw(component, 160);

		expect(rendered).toContain(theme.getFgAnsi("syntaxVariable"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxFunction"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxString"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxOperator"));
		expect(rendered).toContain(theme.getFgAnsi("syntaxComment"));
		expect(rendered).not.toContain(theme.getFgAnsi("accent") + 'FOO=bar printf "$HOME"');
	});
});
