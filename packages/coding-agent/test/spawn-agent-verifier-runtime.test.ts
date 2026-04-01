import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setCurrentModel, setCurrentThinkingLevel } from "../src/runtime-state.js";
import { spawnAgentTool } from "../src/tools/spawn-agent.js";

function writeDoneBuildMission(dir: string): void {
	writeFileSync(join(dir, "SPEC.md"), "# Goal\nAlready complete\n");
	writeFileSync(join(dir, "PROGRESS.md"), "# Progress\n\n## Last completed task\n- `done`\n");
	writeFileSync(join(dir, "RUNBOOK.md"), "1. Work exactly one task at a time.\n");
	writeFileSync(
		join(dir, "TASKS.json"),
		JSON.stringify(
			{
				tasks: [{ id: "done", title: "Already done", status: "done", validation: [], notes: "" }],
			},
			null,
			2,
		),
	);
}

function writeMissionWithoutSpec(dir: string): void {
	writeFileSync(join(dir, "PROGRESS.md"), "# Progress\n\n## Last completed task\n- `todo`\n");
	writeFileSync(join(dir, "RUNBOOK.md"), "1. Work exactly one task at a time.\n");
	writeFileSync(
		join(dir, "TASKS.json"),
		JSON.stringify(
			{
				tasks: [{ id: "todo", title: "Missing spec", status: "todo", validation: [], notes: "" }],
			},
			null,
			2,
		),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readSessionEntries(sessionFile: string): unknown[] {
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as unknown);
}

function readSessionHeaderTimestamp(sessionFile: string): number {
	const header = readSessionEntries(sessionFile)[0];
	if (!isRecord(header) || typeof header.timestamp !== "string") {
		throw new Error(`Expected session header timestamp in ${sessionFile}`);
	}
	return Date.parse(header.timestamp);
}

function readLatestAssistantTimestamp(sessionFile: string): number {
	let latest = 0;
	for (const entry of readSessionEntries(sessionFile)) {
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
			continue;
		}
		if (entry.message.role !== "assistant" || typeof entry.message.timestamp !== "number") {
			continue;
		}
		latest = Math.max(latest, entry.message.timestamp);
	}
	if (latest === 0) {
		throw new Error(`Expected assistant timestamp in ${sessionFile}`);
	}
	return latest;
}

describe("spawn_agent verifier runtime", () => {
	let configDir: string;
	let previousConfigDir: string | undefined;
	let previousOpenAiKey: string | undefined;
	let previousDeterministicVerifier: string | undefined;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "mu-spawn-agent-verifier-runtime-"));
		previousConfigDir = process.env.MU_CODING_AGENT_DIR;
		previousOpenAiKey = process.env.OPENAI_API_KEY;
		previousDeterministicVerifier = process.env.MU_SPAWN_AGENT_DETERMINISTIC_VERIFIER;
		process.env.MU_CODING_AGENT_DIR = configDir;
		process.env.OPENAI_API_KEY = previousOpenAiKey || "test-openai-key";
		process.env.MU_SPAWN_AGENT_DETERMINISTIC_VERIFIER = "1";

		const model = getModel("openai", "gpt-5.1-codex");
		if (!model) {
			throw new Error("Expected openai/gpt-5.1-codex model to exist");
		}
		setCurrentModel(model);
		setCurrentThinkingLevel("off");
	});

	afterEach(() => {
		if (previousConfigDir === undefined) {
			delete process.env.MU_CODING_AGENT_DIR;
		} else {
			process.env.MU_CODING_AGENT_DIR = previousConfigDir;
		}
		if (previousOpenAiKey === undefined) {
			delete process.env.OPENAI_API_KEY;
		} else {
			process.env.OPENAI_API_KEY = previousOpenAiKey;
		}
		if (previousDeterministicVerifier === undefined) {
			delete process.env.MU_SPAWN_AGENT_DETERMINISTIC_VERIFIER;
		} else {
			process.env.MU_SPAWN_AGENT_DETERMINISTIC_VERIFIER = previousDeterministicVerifier;
		}
		rmSync(configDir, { recursive: true, force: true });
	});

	test("mission startup defaults verification on and returns a completed PASS composite result", async () => {
		const missionDir = mkdtempSync(join(tmpdir(), "mu-spawn-agent-verifier-pass-"));
		try {
			writeDoneBuildMission(missionDir);

			const result = (await spawnAgentTool.execute("toolcall_spawn_mission_verify_runtime", {
				startup: {
					type: "mission",
					missionPath: missionDir,
				},
			} as never)) as {
				details?: {
					worker?: { sessionId?: string; sessionFile?: string };
					workerResult?: { status?: string; text?: string };
					verifier?: { sessionId?: string; sessionFile?: string };
					verifierResult?: { status?: string };
					verificationReport?: { status?: string; issues?: string[] };
				};
				isError?: boolean;
			};

			expect(result.isError).not.toBe(true);
			expect(result.details?.worker?.sessionId).toBeTruthy();
			expect(result.details?.verifier?.sessionId).toBeTruthy();
			expect(result.details?.worker?.sessionId).not.toBe(result.details?.verifier?.sessionId);
			expect(result.details?.workerResult?.status).toBe("completed");
			expect(result.details?.workerResult?.text).toMatch(/Mission .* done/i);
			expect(result.details?.verifierResult?.status).toBe("completed");
			expect(result.details?.verificationReport).toEqual({ status: "PASS", issues: [] });
		} finally {
			rmSync(missionDir, { recursive: true, force: true });
		}
	});

	test("mission verification can be explicitly opted out", async () => {
		const missionDir = mkdtempSync(join(tmpdir(), "mu-spawn-agent-verifier-optout-"));
		try {
			writeDoneBuildMission(missionDir);

			const result = (await spawnAgentTool.execute("toolcall_spawn_mission_verify_optout", {
				startup: {
					type: "mission",
					missionPath: missionDir,
				},
				verify: false,
			} as never)) as {
				details?: {
					sessionId?: string;
					sessionFile?: string;
					worker?: unknown;
					verificationReport?: unknown;
				};
				isError?: boolean;
			};

			expect(result.isError).not.toBe(true);
			expect(result.details?.sessionId).toBeTruthy();
			expect(result.details?.worker).toBeUndefined();
			expect(result.details?.verificationReport).toBeUndefined();
		} finally {
			rmSync(missionDir, { recursive: true, force: true });
		}
	});

	test("verifier session is created only after the worker has already completed", async () => {
		const missionDir = mkdtempSync(join(tmpdir(), "mu-spawn-agent-verifier-sequence-"));
		try {
			writeDoneBuildMission(missionDir);

			const result = (await spawnAgentTool.execute("toolcall_spawn_mission_verify_sequence", {
				startup: {
					type: "mission",
					missionPath: missionDir,
				},
			} as never)) as {
				details?: {
					worker?: { sessionFile?: string };
					verifier?: { sessionFile?: string };
				};
				isError?: boolean;
			};

			expect(result.isError).not.toBe(true);
			const workerSessionFile = result.details?.worker?.sessionFile;
			const verifierSessionFile = result.details?.verifier?.sessionFile;
			expect(workerSessionFile).toBeTruthy();
			expect(verifierSessionFile).toBeTruthy();

			const workerCompletedAt = readLatestAssistantTimestamp(workerSessionFile ?? "");
			const verifierStartedAt = readSessionHeaderTimestamp(verifierSessionFile ?? "");
			expect(verifierStartedAt).toBeGreaterThanOrEqual(workerCompletedAt);
		} finally {
			rmSync(missionDir, { recursive: true, force: true });
		}
	});

	test("verification reports FAIL with concrete issues when the worker mission is broken", async () => {
		const missionDir = mkdtempSync(join(tmpdir(), "mu-spawn-agent-verifier-fail-"));
		try {
			writeMissionWithoutSpec(missionDir);

			const result = (await spawnAgentTool.execute("toolcall_spawn_mission_verify_fail", {
				startup: {
					type: "mission",
					missionPath: missionDir,
				},
				verificationChecks: ["Reads SPEC.md from missionPath"],
			} as never)) as {
				details?: {
					workerResult?: { status?: string };
					verificationReport?: { status?: string; issues?: string[] };
				};
				isError?: boolean;
			};

			expect(result.isError).not.toBe(true);
			expect(result.details?.workerResult?.status).not.toBe("completed");
			expect(result.details?.verificationReport?.status).toBe("FAIL");
			expect(result.details?.verificationReport?.issues).toEqual(
				expect.arrayContaining([
					expect.stringMatching(/SPEC\.md/i),
					expect.stringMatching(/did not complete successfully/i),
				]),
			);
		} finally {
			rmSync(missionDir, { recursive: true, force: true });
		}
	});
});
