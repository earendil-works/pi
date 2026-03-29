import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@kennyfrc/mu-ai";
import { TypeGuard } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getToolDescription } from "../src/prompts/index.js";
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

describe("spawn_agent mission startup contract (red)", () => {
	let configDir: string;
	let previousConfigDir: string | undefined;
	let previousOpenAiKey: string | undefined;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "mu-spawn-agent-mission-red-"));
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

	test("registers a startup parameter so a child can be launched directly into mission mode", () => {
		expect(TypeGuard.IsObject(spawnAgentTool.parameters)).toBe(true);

		if (!TypeGuard.IsObject(spawnAgentTool.parameters)) {
			return;
		}

		const properties = (spawnAgentTool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
		expect(properties).toHaveProperty("startup");

		const startup = properties.startup;
		expect(startup).toBeDefined();
		expect(JSON.stringify(startup)).toMatch(/mission/i);
		expect(JSON.stringify(startup)).toMatch(/missionPath|mission path|mission-path/i);
	});

	test("tool description teaches mission startup mode in addition to freeform task delegation", () => {
		const description = getToolDescription("spawn_agent");

		expect(description).toMatch(/startup/i);
		expect(description).toMatch(/mission/i);
		expect(description).toMatch(/missionPath|mission path|mission-path/i);
	});

	test("allows startup-only mission spawning and the child completes a done mission without a freeform prompt", async () => {
		const missionDir = mkdtempSync(join(tmpdir(), "mu-spawn-agent-mission-done-"));
		try {
			writeDoneBuildMission(missionDir);

			const result = (await spawnAgentTool.execute("toolcall_spawn_mission", {
				startup: {
					type: "mission",
					missionPath: missionDir,
				},
			} as never)) as {
				content: Array<{ type: "text"; text: string }>;
				details?: { sessionId: string; sessionFile: string };
				isError?: boolean;
			};

			expect(result.isError).not.toBe(true);
			expect(result.details?.sessionId).toBeTruthy();
			expect(result.details?.sessionFile).toBeTruthy();

			const inspected = await waitForChildTerminalState(
				result.details?.sessionId ?? "",
				result.details?.sessionFile ?? "",
				5_000,
			);

			expect(inspected.status).toBe("completed");
			expect(inspected.text).toMatch(/mission/i);
			expect(inspected.text).toMatch(/done/i);
		} finally {
			rmSync(missionDir, { recursive: true, force: true });
		}
	});
});
