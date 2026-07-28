/**
 * Focused presentation coverage for hiding raw tool trace until expanded.
 */

import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const noopUi = { requestRender() {} } as unknown as TUI;

describe("ToolExecutionComponent focused presentation", () => {
	test("hides collapsed tool trace and reveals it when expanded", () => {
		initTheme("dark");

		const component = new ToolExecutionComponent(
			"bash",
			"tool-1",
			{ command: "pwd && ls && git status --short --branch" },
			{ hideWhenCollapsed: true },
			undefined,
			noopUi,
			process.cwd(),
		);

		expect(component.render(100)).toEqual([]);

		component.setExpanded(true);
		const rendered = stripAnsi(component.render(100).join("\n"));
		expect(rendered).toContain("bash");
		expect(rendered).toContain("pwd && ls && git status --short --branch");
	});
});
