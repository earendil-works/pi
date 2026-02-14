import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { parseApplyPatchInput } from "../tools/apply-patch/parse.js";
import { ToolExecutionComponent } from "./tool-execution.js";

describe("ToolExecutionComponent apply_patch", () => {
	it("renders a diff-like preview without JSON args", () => {
		initTheme("dark");
		const input = ["*** Begin Patch", "*** Delete File: demo.txt", "@@", "-old", "+new", "*** End Patch"].join("\n");
		const parsed = parseApplyPatchInput(input);
		const component = new ToolExecutionComponent("apply_patch", { input });
		component.updateResult({
			content: [{ type: "text", text: "Success. Updated the following files:\nD demo.txt\n" }],
			details: { parsed },
			isError: false,
		});

		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("ApplyPatch");
		expect(rendered).toContain("*** Delete File: demo.txt");
		expect(rendered).toContain("+new");
		expect(rendered).toContain("-old");
		expect(rendered).not.toContain('"input"');
	});
});
