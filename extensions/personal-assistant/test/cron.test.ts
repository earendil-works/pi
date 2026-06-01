import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the os module before importing cron
vi.mock("node:os", () => ({
	homedir: vi.fn(() => "/fake-home"),
	tmpdir: vi.fn(() => "/tmp"),
}));

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCron, isOverdue } from "../cron.ts";

let tmpDir: string;
let registeredTool: any = null;
let eventHandlers: Record<string, any> = {};

function createMockPi(): ExtensionAPI {
	eventHandlers = {};
	registeredTool = null;
	return {
		registerTool: (tool: any) => {
			registeredTool = tool;
		},
		on: (event: string, handler: any) => {
			eventHandlers[event] = handler;
		},
	} as unknown as ExtensionAPI;
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-test-"));
	(os.homedir as ReturnType<typeof vi.fn>).mockReturnValue(tmpDir);
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function getCronFilePath(): string {
	return path.join(tmpDir, ".pi", "agent", "data", "cron.json");
}

function readJobs(): any[] {
	const filePath = getCronFilePath();
	if (!fs.existsSync(filePath)) {
		return [];
	}
	return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

describe("cron extension - 5 actions", () => {
	it("(a) adds a new job", async () => {
		const mockPi = createMockPi();
		registerCron(mockPi);

		const result = await registeredTool.execute("op-1", {
			operations: [
				{
					action: "add",
					name: "Test Job",
					schedule: { kind: "at", time: "09:00" },
					prompt: "Say hello",
				},
			],
		});

		expect(result.content[0].text).toContain("OK");
		expect(result.content[0].text).toContain("Added job: Test Job");

		const jobs = readJobs();
		expect(jobs).toHaveLength(1);
		expect(jobs[0].name).toBe("Test Job");
		expect(jobs[0].schedule).toEqual({ kind: "at", time: "09:00" });
		expect(jobs[0].enabled).toBe(true);
		expect(jobs[0].last_run).toBeNull();
	});

	it("(b) trigger_now sets last_run to null", async () => {
		const mockPi = createMockPi();
		registerCron(mockPi);

		// First add a job with a known last_run
		const addResult = await registeredTool.execute("op-1", {
			operations: [
				{
					action: "add",
					name: "Existing Job",
					schedule: { kind: "every", interval: 3600 },
					prompt: "Test prompt",
				},
			],
		});
		expect(addResult.content[0].text).toContain("OK");

		// Get the job id
		const jobsAfterAdd = readJobs();
		expect(jobsAfterAdd).toHaveLength(1);
		const jobId = jobsAfterAdd[0].id;

		// Set last_run to a specific time (simulating it was run before)
		jobsAfterAdd[0].last_run = "2025-01-01T00:00:00Z";
		fs.writeFileSync(getCronFilePath(), JSON.stringify(jobsAfterAdd, null, 2));

		// Now call trigger_now
		const triggerResult = await registeredTool.execute("op-2", {
			operations: [{ action: "trigger_now", id: jobId }],
		});

		expect(triggerResult.content[0].text).toContain("OK");
		expect(triggerResult.content[0].text).toContain("Triggered job: Existing Job");

		// Verify last_run is now null
		const jobsAfterTrigger = readJobs();
		expect(jobsAfterTrigger).toHaveLength(1);
		expect(jobsAfterTrigger[0].id).toBe(jobId);
		expect(jobsAfterTrigger[0].last_run).toBeNull();
	});

	it("(c) isOverdue returns true after trigger_now", async () => {
		const mockPi = createMockPi();
		registerCron(mockPi);

		// Add a job with an "every" schedule and a recent last_run
		const addResult = await registeredTool.execute("op-1", {
			operations: [
				{
					action: "add",
					name: "Interval Job",
					schedule: { kind: "every", interval: 60 },
					prompt: "Test prompt",
				},
			],
		});
		expect(addResult.content[0].text).toContain("OK");

		const jobsAfterAdd = readJobs();
		expect(jobsAfterAdd).toHaveLength(1);
		const jobId = jobsAfterAdd[0].id;
		const job = jobsAfterAdd[0];

		// Verify isOverdue is false when last_run is set to recent time
		const now = new Date();
		const recentDate = new Date(now.getTime() - 30 * 1000); // 30 seconds ago
		job.last_run = recentDate.toISOString();
		expect(isOverdue(job, now)).toBe(false);

		// Now call trigger_now which sets last_run to null
		const triggerResult = await registeredTool.execute("op-2", {
			operations: [{ action: "trigger_now", id: jobId }],
		});
		expect(triggerResult.content[0].text).toContain("OK");

		// Read the job back from file
		const jobsAfterTrigger = readJobs();
		const updatedJob = jobsAfterTrigger.find((j: any) => j.id === jobId);
		expect(updatedJob.last_run).toBeNull();

		// Verify isOverdue returns true for a job with last_run=null and "every" schedule
		expect(isOverdue(updatedJob, now)).toBe(true);
	});

	it("(d) backward compat: add, list, toggle, remove still work", async () => {
		const mockPi = createMockPi();
		registerCron(mockPi);

		// (1) ADD
		const addResult = await registeredTool.execute("op-1", {
			operations: [
				{
					action: "add",
					name: "Compat Job",
					schedule: { kind: "cron", expr: "0 9 * * 1-5" },
					prompt: "Morning standup",
				},
			],
		});
		expect(addResult.content[0].text).toContain("OK");
		expect(addResult.content[0].text).toContain("Added job: Compat Job");

		let jobs = readJobs();
		expect(jobs).toHaveLength(1);
		const jobId = jobs[0].id;

		// (2) LIST
		const listResult = await registeredTool.execute("op-2", {
			operations: [{ action: "list" }],
		});
		expect(listResult.content[0].text).toContain("Found 1 jobs");
		expect(listResult.details.jobs).toHaveLength(1);
		expect(listResult.details.jobs[0].name).toBe("Compat Job");

		// (3) TOGGLE (disable)
		const toggleResult = await registeredTool.execute("op-3", {
			operations: [{ action: "toggle", id: jobId, enabled: false }],
		});
		expect(toggleResult.content[0].text).toContain("OK");
		expect(toggleResult.content[0].text).toContain("Disabled job: Compat Job");

		jobs = readJobs();
		expect(jobs[0].enabled).toBe(false);

		// (4) REMOVE
		const removeResult = await registeredTool.execute("op-4", {
			operations: [{ action: "remove", id: jobId }],
		});
		expect(removeResult.content[0].text).toContain("OK");
		expect(removeResult.content[0].text).toContain("Removed job: Compat Job");

		jobs = readJobs();
		expect(jobs).toHaveLength(0);
	});
});
