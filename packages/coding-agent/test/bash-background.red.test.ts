import { afterEach, describe, expect, it } from "vitest";
import { bashTool } from "../src/tools/bash.js";

type TextBlock = { type: "text"; text: string };
type ToolResult = {
	content: TextBlock[];
	details?: {
		backgroundJob?: {
			id: string;
			pid: number;
			status: "running" | "exited" | "killed" | "failed";
			command: string;
			reason: "explicit_background" | "timeout_promoted";
		};
	};
};

function getTextOutput(result: ToolResult): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

describe("bash tool background execution (red)", () => {
	afterEach(() => {
		// Keep tests isolated from each other if later implementations add process tracking.
	});

	it("promotes long-running commands to background jobs when the timeout budget is exceeded", async () => {
		const result = (await bashTool.execute("bash-red-timeout", {
			command: 'sleep 2; printf "should-not-print"',
			timeout: 1,
		} as unknown as { command: string; timeout?: number })) as ToolResult;

		expect(result.details?.backgroundJob).toBeDefined();
		expect(result.details?.backgroundJob).toMatchObject({
			status: "running",
			reason: "timeout_promoted",
			command: 'sleep 2; printf "should-not-print"',
		});
		expect(getTextOutput(result)).toContain("Command exceeded timeout");
	}, 5_000);

	it("returns immediately with background job metadata when background mode is requested", async () => {
		const startedAt = Date.now();
		const result = (await bashTool.execute("bash-red-background", {
			command: 'sleep 2; printf "background-finished"',
			background: true,
		} as unknown as { command: string; timeout?: number })) as ToolResult;

		const elapsedMs = Date.now() - startedAt;
		expect(elapsedMs).toBeLessThan(1_000);

		expect(result.details?.backgroundJob).toBeDefined();
		expect(result.details?.backgroundJob).toMatchObject({
			status: "running",
			reason: "explicit_background",
			command: 'sleep 2; printf "background-finished"',
		});
		expect(result.details?.backgroundJob?.id).toMatch(/\S+/);
		expect(result.details?.backgroundJob?.pid).toBeGreaterThan(0);

		expect(getTextOutput(result)).toContain("Started background job");
		expect(getTextOutput(result)).toContain("by request");
	}, 5_000);
});
