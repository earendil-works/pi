import { describe, expect, it } from "vitest";

import type { HandoffDetails } from "../src/tools/handoff.js";
import { compactTool } from "../src/tools/handoff.js";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: HandoffDetails;
	isError?: boolean;
};

describe("compact tool summary-only contract", () => {
	it("accepts only a goal parameter and returns a summary compaction request", async () => {
		expect(Object.keys(compactTool.parameters.properties)).toEqual(["goal"]);

		const result = (await compactTool.execute("tool-compact", { goal: "Continue the task" })) as ToolResult;

		expect(result.isError).not.toBe(true);
		expect(result.details.goal).toBe("Continue the task");
		expect(result.details.formattedMessage).toBe("");
		expect(result.details.fileTokens).toBe(0);
		expect(result.details.keyFiles).toEqual([]);
		expect(result.content[0]).toEqual({
			type: "text",
			text: 'Compaction requested: "Continue the task"',
		});
	});
});
