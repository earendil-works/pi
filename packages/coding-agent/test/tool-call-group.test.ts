import { beforeAll, describe, expect, it } from "vitest";
import {
	formatToolCallGroupSummary,
	TOOL_CALL_GROUP_THRESHOLD,
	ToolCallGroupComponent,
} from "../src/modes/interactive/components/tool-call-group.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const tui = { requestRender: () => {} } as any;

describe("tool call groups", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("groups only runs of six or more calls", () => {
		expect(TOOL_CALL_GROUP_THRESHOLD).toBe(6);
	});

	it("summarizes calls in first-seen tool order", () => {
		expect(formatToolCallGroupSummary(["read", "glob", "read", "bash", "read", "bash", "grep", "read"], 2)).toEqual({
			calls: "8 tool calls",
			counts: "4 Read 1 Glob 2 Bash 1 Grep",
			errors: "2 errors",
		});
	});

	it("keeps successful members hidden while retaining failed calls and error metadata", () => {
		const tools = ["read", "read", "bash", "read", "grep", "bash"].map(
			(name, index) => new ToolExecutionComponent(name, `call-${index}`, {}, {}, undefined, tui, "/tmp"),
		);
		tools[4]?.updateResult({ content: [{ type: "text", text: "failed" }], isError: true });

		const group = new ToolCallGroupComponent(tools, tui);
		const collapsed = stripAnsi(group.render(120).join("\n"));
		expect(collapsed).toContain("6 tool calls 3 Read 2 Bash 1 Grep 1 error expand");
		expect(collapsed).toContain("failed");

		group.setExpanded(true);
		const expanded = stripAnsi(group.render(120).join("\n"));
		expect(expanded).toContain("collapse");
		expect(expanded).toContain("failed");
	});

	it("omits the error count when every call succeeds", () => {
		expect(formatToolCallGroupSummary(["read"], 0).errors).toBeUndefined();
	});
});
