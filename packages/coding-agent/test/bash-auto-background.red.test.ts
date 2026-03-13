import { afterEach, describe, expect, it } from "vitest";
import { getBackgroundJob, killAllBackgroundJobs } from "../src/tools/bash.js";
import { execCommandTool } from "../src/tools/exec-command.js";

type TextBlock = { type: "text"; text: string };
type ToolResult = {
	content: TextBlock[];
	details?: {
		backgroundJob?: {
			id: string;
			pid: number;
			status: "running" | "exited" | "killed" | "failed";
			command: string;
		};
	};
};

function getTextOutput(result: ToolResult): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

describe("shell commands auto-background long-running work (red)", () => {
	afterEach(() => {
		killAllBackgroundJobs();
	});

	it("bash promotes a long-running command to a background job instead of failing on timeout", async () => {
		const startedAt = Date.now();
		const result = (await import("../src/tools/bash.js")).bashTool.execute("bash-auto-background", {
			command: 'sleep 2; printf "background-complete"',
			timeout: 1,
		}) as Promise<ToolResult>;

		const resolved = await result;
		const elapsedMs = Date.now() - startedAt;
		expect(elapsedMs).toBeLessThan(1_500);

		const job = resolved.details?.backgroundJob;
		expect(job).toBeDefined();
		expect(job).toMatchObject({
			status: "running",
			command: 'sleep 2; printf "background-complete"',
		});
		expect(job?.id).toMatch(/\S+/);
		expect(job?.pid).toBeGreaterThan(0);

		const snapshot = job?.id ? getBackgroundJob(job.id) : undefined;
		expect(snapshot?.status).toBe("running");
		expect(getTextOutput(resolved)).toContain("Started background job");
	}, 5_000);

	it("exec_command returns promptly with background metadata when yield_time_ms is exceeded", async () => {
		const startedAt = Date.now();
		const result = (await execCommandTool.execute("exec-auto-background", {
			cmd: 'sleep 2; printf "exec-background-complete"',
			yield_time_ms: 250,
		})) as unknown as ToolResult;

		const elapsedMs = Date.now() - startedAt;
		expect(elapsedMs).toBeLessThan(1_200);

		const job = result.details?.backgroundJob;
		expect(job).toBeDefined();
		expect(job).toMatchObject({
			status: "running",
			command: 'sleep 2; printf "exec-background-complete"',
		});
		expect(job?.id).toMatch(/\S+/);

		const snapshot = job?.id ? getBackgroundJob(job.id) : undefined;
		expect(snapshot?.status).toBe("running");
		expect(getTextOutput(result)).toContain("Started background job");
	}, 5_000);
});
