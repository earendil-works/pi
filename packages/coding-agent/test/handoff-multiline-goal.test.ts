import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
			const file = join(dir, "a.ts");
			writeFileSync(file, "export const x = 1;\n");

			const goal = "Fix handoff prompt\n\nContext: users paste multiline goals";
			const result = (await handoffTool.execute("call", { goal, files: [file] })) as ToolResult;
			expect(result.isError).not.toBe(true);

			// Title stays short.
			expect(result.details.goal).toBe("Fix handoff prompt");
			expect(result.details.formattedMessage).toContain("# Handoff: Fix handoff prompt");

			// But the full goal should be included for the next session.
			expect(result.details.formattedMessage).toContain("Context: users paste multiline goals");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
