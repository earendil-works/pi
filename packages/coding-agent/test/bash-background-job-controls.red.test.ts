import { afterEach, describe, expect, it } from "vitest";
import { bashTool, killAllBackgroundJobs } from "../src/tools/bash.js";

type TextBlock = { type: "text"; text: string };
type BackgroundJobReason = "explicit_background" | "timeout_promoted";
type BackgroundJobStatus = "running" | "exited" | "killed" | "failed";
type ToolResult = {
	content: TextBlock[];
	details?: {
		backgroundJob?: {
			id: string;
			pid: number;
			status: BackgroundJobStatus;
			command: string;
			reason: BackgroundJobReason;
			exitCode?: number;
			recentOutput?: string;
			recentStdout?: string;
			recentStderr?: string;
			startedAt?: number;
			endedAt?: number;
		};
	};
};

function getTextOutput(result: ToolResult): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("bash tool background job controls (red)", () => {
	afterEach(() => {
		killAllBackgroundJobs();
	});

	it("returns an agent-facing timeout promotion diagnostic with a reusable job handle", async () => {
		const result = (await bashTool.execute("bash-red-timeout-diagnostic", {
			command: 'sleep 2; printf "done"',
			timeout: 0.2,
		} as unknown as { command: string; timeout?: number })) as ToolResult;

		const job = result.details?.backgroundJob;
		expect(job).toBeDefined();
		expect(job).toMatchObject({
			status: "running",
			reason: "timeout_promoted",
			command: 'sleep 2; printf "done"',
		});

		const text = getTextOutput(result);
		expect(text).toContain("Command exceeded timeout");
		expect(text).toContain("preserves in-progress work instead of killing the process");
		expect(text).toContain(`{"job":"${job?.id}","action":"status"}`);
		expect(text).toContain(`{"job":"${job?.id}","action":"wait","timeout":30}`);
	}, 5_000);

	it("returns an agent-facing explicit background diagnostic with a reusable job handle", async () => {
		const result = (await bashTool.execute("bash-red-explicit-diagnostic", {
			command: 'sleep 2; printf "done"',
			background: true,
		} as unknown as { command: string; background?: boolean })) as ToolResult;

		const job = result.details?.backgroundJob;
		expect(job).toBeDefined();
		expect(job).toMatchObject({
			status: "running",
			reason: "explicit_background",
			command: 'sleep 2; printf "done"',
		});

		const text = getTextOutput(result);
		expect(text).toContain("Started background job");
		expect(text).toContain("by request");
		expect(text).toContain(`{"job":"${job?.id}","action":"status"}`);
	}, 5_000);

	it("reports current progress for a running background job via action=status", async () => {
		const started = (await bashTool.execute("bash-red-status-start", {
			command: 'printf "first\\n"; sleep 2; printf "second\\n"',
			background: true,
		} as unknown as { command: string; background?: boolean })) as ToolResult;

		const jobId = started.details?.backgroundJob?.id;
		expect(jobId).toBeDefined();
		await sleep(150);

		const status = (await bashTool.execute("bash-red-status", {
			job: jobId,
			action: "status",
		} as unknown as { job: string; action: "status" })) as ToolResult;

		expect(status.details?.backgroundJob).toMatchObject({
			id: jobId,
			status: "running",
			reason: "explicit_background",
		});
		expect(status.details?.backgroundJob?.recentOutput).toContain("first");
		expect(getTextOutput(status)).toContain("still running");
	}, 5_000);

	it("waits for a background job to finish via action=wait", async () => {
		const started = (await bashTool.execute("bash-red-wait-start", {
			command: 'sleep 0.2; printf "finished"',
			background: true,
		} as unknown as { command: string; background?: boolean })) as ToolResult;

		const jobId = started.details?.backgroundJob?.id;
		expect(jobId).toBeDefined();

		const waited = (await bashTool.execute("bash-red-wait", {
			job: jobId,
			action: "wait",
			timeout: 2,
		} as unknown as { job: string; action: "wait"; timeout?: number })) as ToolResult;

		expect(waited.details?.backgroundJob).toMatchObject({
			id: jobId,
			status: "exited",
			exitCode: 0,
		});
		expect(waited.details?.backgroundJob?.recentOutput).toContain("finished");
		expect(getTextOutput(waited)).toContain("completed successfully");
	}, 5_000);

	it("kills a running background job via action=kill", async () => {
		const started = (await bashTool.execute("bash-red-kill-start", {
			command: "sleep 30",
			background: true,
		} as unknown as { command: string; background?: boolean })) as ToolResult;

		const jobId = started.details?.backgroundJob?.id;
		expect(jobId).toBeDefined();

		const killed = (await bashTool.execute("bash-red-kill", {
			job: jobId,
			action: "kill",
		} as unknown as { job: string; action: "kill" })) as ToolResult;

		expect(killed.details?.backgroundJob).toMatchObject({
			id: jobId,
			status: "killed",
		});
		expect(getTextOutput(killed)).toContain("Killed background job");
	}, 5_000);
});
