import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, type ToolResultMessage } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import {
	buildSpawnedAgentsReminder,
	collectSpawnedAgentsFromParentSession,
	formatSpawnedAgentsReport,
} from "../src/spawned-agents.js";

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

describe("spawn_agent verifier reporting", () => {
	let configDir: string;
	let previousConfigDir: string | undefined;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "mu-spawn-agent-verifier-reporting-"));
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

	test("formats composite worker/verifier results with PASS/FAIL findings", () => {
		const model = getModel("openai", "gpt-5.1-codex");
		if (!model) throw new Error("Expected model to exist");

		const parent = new SessionManager(false, undefined, false, workspacePath);
		parent.startSession({ model, thinkingLevel: "off" } as never);

		parent.saveMessage(
			buildToolResultMessage("spawn_agent", {
				worker: {
					sessionId: "worker-session-id",
					sessionFile: "/tmp/worker-session.jsonl",
					effectiveModel: "openai/gpt-5.1-codex",
					effectiveReasoning: "off",
				},
				workerResult: {
					status: "completed",
					text: "Mission example done after 1 iteration.",
				},
				verifier: {
					sessionId: "verifier-session-id",
					sessionFile: "/tmp/verifier-session.jsonl",
					effectiveModel: "openai/gpt-5.1-codex",
					effectiveReasoning: "off",
				},
				verifierResult: {
					status: "completed",
					text: "<verification_report><status>FAIL</status><issues><issue>SPEC.md was not checked</issue></issues></verification_report>",
				},
				verificationReport: {
					status: "FAIL",
					issues: ["SPEC.md was not checked"],
				},
			}),
		);

		const report = formatSpawnedAgentsReport(parent.getSessionFile());
		expect(report).toContain("worker worker-session-id completed waited");
		expect(report).toContain("verifier verifier-session-id completed waited");
		expect(report).toContain("verification FAIL");
		expect(report).toContain("SPEC.md was not checked");
	});

	test("does not create an unwaited reminder when composite verifier results are already embedded", () => {
		const model = getModel("openai", "gpt-5.1-codex");
		if (!model) throw new Error("Expected model to exist");

		const parent = new SessionManager(false, undefined, false, workspacePath);
		parent.startSession({ model, thinkingLevel: "off" } as never);

		parent.saveMessage(
			buildToolResultMessage("spawn_agent", {
				worker: {
					sessionId: "worker-session-id",
					sessionFile: "/tmp/worker-session.jsonl",
					effectiveModel: "openai/gpt-5.1-codex",
					effectiveReasoning: "off",
				},
				workerResult: {
					status: "completed",
					text: "Mission example done after 1 iteration.",
				},
				verifier: {
					sessionId: "verifier-session-id",
					sessionFile: "/tmp/verifier-session.jsonl",
					effectiveModel: "openai/gpt-5.1-codex",
					effectiveReasoning: "off",
				},
				verifierResult: {
					status: "completed",
					text: "<verification_report><status>PASS</status><issues></issues></verification_report>",
				},
				verificationReport: {
					status: "PASS",
					issues: [],
				},
			}),
		);

		const summaries = collectSpawnedAgentsFromParentSession(parent.getSessionFile());
		expect(summaries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sessionId: "worker-session-id",
					waited: true,
					role: "worker",
					status: "completed",
				}),
				expect.objectContaining({
					sessionId: "verifier-session-id",
					waited: true,
					role: "verifier",
					status: "completed",
					verificationStatus: "PASS",
				}),
			]),
		);

		expect(buildSpawnedAgentsReminder(parent.getSessionFile())).toBeNull();
	});
});
