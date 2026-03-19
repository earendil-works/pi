import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type HandoffDetails, handoffTool } from "../src/tools/handoff.js";

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: HandoffDetails;
	isError?: boolean;
};

describe("handoffTool multiline goal", () => {
	it("keeps a one-line title but preserves the full multiline goal in the draft", async () => {
		const dir = join(tmpdir(), `handoff-multiline-${Date.now()}`);
		mkdirSync(dir, { recursive: true });

		try {
			const goal = "Fix handoff prompt\n\nContext: users paste multiline goals";
			const result = (await handoffTool.execute("call", { goal })) as ToolResult;
			expect(result.isError).not.toBe(true);

			expect(result.details.goal).toBe(goal);
			expect(result.details.formattedMessage).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
