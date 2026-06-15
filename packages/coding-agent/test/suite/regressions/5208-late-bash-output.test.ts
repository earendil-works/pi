import { describe, expect, it } from "vitest";
import { type BashOperations, createBashTool } from "../../../src/core/tools/bash.ts";

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n") ?? ""
	);
}

describe("regression #5208: late bash output callbacks", () => {
	it("ignores output callbacks after bash operations resolve", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("before\n", "utf-8"));
				setTimeout(() => onData(Buffer.from("late\n", "utf-8")), 0);
				return { exitCode: 0 };
			},
		};
		const bash = createBashTool(process.cwd(), { operations });

		const result = await bash.execute("test-call-late-output", { command: "late-output" });
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(getTextOutput(result).trim()).toBe("before");
	});
});
