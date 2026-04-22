import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, type ToolResultMessage } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getToolDescription, getToolDescriptions } from "../src/prompts/index.js";
import { SessionManager } from "../src/session-manager.js";
import { formatSpawnedAgentsReport } from "../src/spawned-agents.js";

const workspacePath = "/Users/kennyfrc/Documents/code/work/pi-mono";

function buildToolResultMessage(toolName: string, details: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `${toolName}-${Math.random()}`,
		toolName,
		content: [{ type: "text", text: toolName }],
		details,
		isError: false,
		timestamp: Date.now(),
	};
}

describe("spawn_agent verifier prompt and reporting contract (red)", () => {
	let configDir: string;
	let previousConfigDir: string | undefined;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "mu-spawn-agent-verifier-prompts-red-"));
		previousConfigDir = process.env.MU_CODING_AGENT_DIR;
		process.env.MU_CODING_AGENT_DIR = configDir;
	});

	afterEach(() => {
		if (previousConfigDir === undefined) {
			delete process.env.MU_CODING_AGENT_DIR;
		} else {
			process.env.MU_CODING_AGENT_DIR = previousConfigDir;
		}
		rmSync(configDir, { recursive: true, force: true });
	});

	test("full spawn_agent tool description teaches verification metadata and spec-file startup context", () => {
		const description = getToolDescription("spawn_agent");

		expect(description).toMatch(/verifier/i);
		expect(description).toMatch(/verificationChecks/i);
		expect(description).toMatch(/validation metadata/i);
		expect(description).toMatch(/spec context|specPath/i);
		expect(description).toMatch(/specPath|spec path|spec-file|spec file/i);
		expect(description).toMatch(/parent decides|retry|accept|abort/i);
		// New strict contract assertions
		expect(description).toMatch(/ALWAYS required|REQUIRED/i);
		expect(description).toMatch(/SERIALIZES by default/i);
	});

	test("short system prompt description makes verifier support discoverable in the available-tools list", () => {
		const descriptions = getToolDescriptions();
		expect(descriptions.spawn_agent).toMatch(/verify|verification|verifier/i);
	});

	test("spawned-agent reporting can render simple worker results", () => {
		const model = getModel("openai", "gpt-5.1-codex");
		if (!model) throw new Error("Expected model to exist");

		const parent = new SessionManager(false, undefined, false, workspacePath);
		parent.startSession({ model, thinkingLevel: "off" } as never);

		parent.saveMessage(
			buildToolResultMessage("spawn_agent", {
				processName: "worker-test",
				sessionId: "worker-session-id",
				sessionFile: "/tmp/worker-session.jsonl",
				effectiveModel: "openai/gpt-5.1-codex",
				effectiveReasoning: "off",
				pid: 12345,
				status: "running",
			}),
		);

		const report = formatSpawnedAgentsReport(parent.getSessionFile());
		expect(report).toContain("worker-session-id");
		expect(report).toContain("openai/gpt-5.1-codex");
		expect(report).toContain("unwaited");
	});
});
