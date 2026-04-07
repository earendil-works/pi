import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@kennyfrc/mu-ai";
import { TypeGuard } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setCurrentModel, setCurrentThinkingLevel } from "../src/runtime-state.js";
import { inspectSpawnedAgentSession } from "../src/spawned-agents.js";
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

async function waitForChildTerminalState(
	sessionId: string,
	sessionFile: string,
	timeoutMs: number,
): Promise<ReturnType<typeof inspectSpawnedAgentSession>> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const inspected = inspectSpawnedAgentSession(sessionId, sessionFile);
		if (inspected.status !== "running") {
			return inspected;
		}
		if (Date.now() >= deadline) {
			return inspected;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("spawn_agent verifier contract (red)", () => {
	let configDir: string;
	let previousConfigDir: string | undefined;
	let previousOpenAiKey: string | undefined;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "mu-spawn-agent-verifier-contract-red-"));
		previousConfigDir = process.env.MU_CODING_AGENT_DIR;
		previousOpenAiKey = process.env.OPENAI_API_KEY;
		process.env.MU_CODING_AGENT_DIR = configDir;
		process.env.OPENAI_API_KEY = previousOpenAiKey || "test-openai-key";

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
		rmSync(configDir, { recursive: true, force: true });
	});

	test("registers verifier-facing input for verificationChecks (verify is always true, not optional)", () => {
		expect(TypeGuard.IsObject(spawnAgentTool.parameters)).toBe(true);

		if (!TypeGuard.IsObject(spawnAgentTool.parameters)) {
			return;
		}

		const properties = (spawnAgentTool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
		// verify option removed - verification is always enabled
		expect(properties).not.toHaveProperty("verify");
		expect(properties).toHaveProperty("verificationChecks");

		const verificationChecksSchema = JSON.stringify(properties.verificationChecks);
		expect(verificationChecksSchema).toMatch(/array/i);
		expect(verificationChecksSchema).toMatch(/string/i);
		// verificationChecks is now required (minItems: 1)
		expect(verificationChecksSchema).toMatch(/minItems/i);
	});

	test("mission startup now requires verificationChecks because the validation contract is mandatory when verification is on", async () => {
		const missionDir = mkdtempSync(join(tmpdir(), "mu-spawn-agent-verifier-mission-required-checks-red-"));
		try {
			writeDoneBuildMission(missionDir);

			const result = (await spawnAgentTool.execute("toolcall_spawn_mission_verify_default_missing_checks", {
				startup: {
					type: "mission",
					missionPath: missionDir,
				},
			} as never)) as {
				content: Array<{ type: "text"; text: string }>;
				isError?: boolean;
			};

			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toMatch(/verificationChecks/i);
			expect(result.content[0]?.text).toMatch(/validation contract/i);
		} finally {
			rmSync(missionDir, { recursive: true, force: true });
		}
	});

	test("mission startup returns composite worker plus verifier details when verificationChecks are provided", async () => {
		const missionDir = mkdtempSync(join(tmpdir(), "mu-spawn-agent-verifier-mission-red-"));
		try {
			writeDoneBuildMission(missionDir);

			const result = (await spawnAgentTool.execute("toolcall_spawn_mission_verify_default", {
				startup: {
					type: "mission",
					missionPath: missionDir,
				},
				verificationChecks: [
					"Confirm the mission result matches SPEC.md",
					"Return PASS or FAIL with concrete issues",
				],
			} as never)) as {
				content: Array<{ type: "text"; text: string }>;
				details?: {
					worker?: { sessionId?: string; sessionFile?: string };
					verifier?: { sessionId?: string; sessionFile?: string };
					verificationReport?: { status?: string; issues?: string[] };
				};
				isError?: boolean;
			};

			expect(result.isError).not.toBe(true);
			expect(result.details?.worker?.sessionId).toBeTruthy();
			expect(result.details?.worker?.sessionFile).toBeTruthy();
			expect(result.details?.verificationReport?.status).toMatch(/PASS|FAIL/);
			expect(Array.isArray(result.details?.verificationReport?.issues)).toBe(true);
			expect(result.details?.verifier?.sessionId).toBeTruthy();
			expect(result.details?.verifier?.sessionFile).toBeTruthy();

			if (result.details?.worker?.sessionId && result.details.worker.sessionFile) {
				await waitForChildTerminalState(result.details.worker.sessionId, result.details.worker.sessionFile, 5_000);
			}
		} finally {
			rmSync(missionDir, { recursive: true, force: true });
		}
	});

	test("context startup schema is discoverable for non-mission spec-file startup", () => {
		expect(TypeGuard.IsObject(spawnAgentTool.parameters)).toBe(true);

		if (!TypeGuard.IsObject(spawnAgentTool.parameters)) {
			return;
		}

		const properties = (spawnAgentTool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
		const startupSchema = JSON.stringify(properties.startup);
		expect(startupSchema).toMatch(/context/i);
		expect(startupSchema).toMatch(/specPath|spec path|spec-path/i);
	});

	test("explicit verify plus verificationChecks returns the simple PASS/FAIL report shape promised by the spec", async () => {
		const missionDir = mkdtempSync(join(tmpdir(), "mu-spawn-agent-verifier-explicit-red-"));
		try {
			writeDoneBuildMission(missionDir);

			const result = (await spawnAgentTool.execute("toolcall_spawn_mission_verify_explicit", {
				startup: {
					type: "mission",
					missionPath: missionDir,
				},
				verify: true,
				verificationChecks: ["Reads SPEC.md from missionPath", "Returns PASS or FAIL plus issues"],
			} as never)) as {
				details?: {
					verificationReport?: { status?: string; issues?: string[] };
				};
				isError?: boolean;
			};

			expect(result.isError).not.toBe(true);
			expect(result.details?.verificationReport).toEqual(
				expect.objectContaining({
					status: expect.stringMatching(/PASS|FAIL/),
					issues: expect.any(Array),
				}),
			);
		} finally {
			rmSync(missionDir, { recursive: true, force: true });
		}
	});
});
