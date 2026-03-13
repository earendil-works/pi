import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, getModel, type ToolResultMessage } from "@kennyfrc/mu-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import {
	buildSpawnedAgentsReminder,
	collectSpawnedAgentsFromParentSession,
	formatSpawnedAgentsReport,
	type SpawnedAgentSummary,
} from "../src/spawned-agents.js";

const workspacePath = "/Users/kennyfrc/Documents/code/work/pi-mono";

function buildAssistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.1-codex",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function buildToolResultMessage(toolName: string, contentText: string, details: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `${toolName}-${Math.random()}`,
		toolName,
		content: [{ type: "text", text: contentText }],
		details,
		isError: false,
		timestamp: Date.now(),
	};
}

describe("spawned agents helper", () => {
	let configDir: string;
	let previousConfigDir: string | undefined;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "mu-spawned-agents-"));
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

	test("derives spawned children, waited children, and child completion state from session transcripts", () => {
		const model = getModel("openai", "gpt-5.1-codex");
		if (!model) throw new Error("Expected model to exist");

		const parent = new SessionManager(false, undefined, false, workspacePath);
		parent.startSession({ model, thinkingLevel: "off" } as never);

		const childCompleted = new SessionManager(false, undefined, false, workspacePath);
		childCompleted.startSession({ model, thinkingLevel: "off" } as never);
		childCompleted.saveMessage(buildAssistantMessage("CHILD_ALPHA_DONE"));

		const childRunning = new SessionManager(false, undefined, false, workspacePath);
		childRunning.startSession({ model, thinkingLevel: "off" } as never);

		parent.saveMessage(
			buildToolResultMessage("spawn_agent", `Spawned ${childCompleted.getSessionId()}`, {
				sessionId: childCompleted.getSessionId(),
				sessionFile: childCompleted.getSessionFile(),
				effectiveModel: "openai/gpt-5.1-codex",
				effectiveReasoning: "off",
			}),
		);
		parent.saveMessage(
			buildToolResultMessage("spawn_agent", `Spawned ${childRunning.getSessionId()}`, {
				sessionId: childRunning.getSessionId(),
				sessionFile: childRunning.getSessionFile(),
				effectiveModel: "openai/gpt-5.1-codex",
				effectiveReasoning: "off",
			}),
		);
		parent.saveMessage(
			buildToolResultMessage("wait_agent", `Waited for ${childCompleted.getSessionId()}`, {
				results: [
					{
						sessionId: childCompleted.getSessionId(),
						status: "completed",
						stopReason: "stop",
						text: "CHILD_ALPHA_DONE",
					},
				],
			}),
		);

		const summaries = collectSpawnedAgentsFromParentSession(parent.getSessionFile());
		expect(summaries).toEqual(
			expect.arrayContaining<SpawnedAgentSummary>([
				expect.objectContaining({
					sessionId: childCompleted.getSessionId(),
					waited: true,
					status: "completed",
					stopReason: "stop",
					text: "CHILD_ALPHA_DONE",
				}),
				expect.objectContaining({
					sessionId: childRunning.getSessionId(),
					waited: false,
					status: "running",
				}),
			]),
		);
	});

	test("builds a hidden reminder only for unwaited spawned agents", () => {
		const model = getModel("openai", "gpt-5.1-codex");
		if (!model) throw new Error("Expected model to exist");

		const parent = new SessionManager(false, undefined, false, workspacePath);
		parent.startSession({ model, thinkingLevel: "off" } as never);

		const child = new SessionManager(false, undefined, false, workspacePath);
		child.startSession({ model, thinkingLevel: "off" } as never);
		child.saveMessage(buildAssistantMessage("CHILD_BETA_DONE"));

		parent.saveMessage(
			buildToolResultMessage("spawn_agent", `Spawned ${child.getSessionId()}`, {
				sessionId: child.getSessionId(),
				sessionFile: child.getSessionFile(),
				effectiveModel: "openai/gpt-5.1-codex",
				effectiveReasoning: "off",
			}),
		);

		const reminder = buildSpawnedAgentsReminder(parent.getSessionFile());
		expect(reminder).toContain("<system_reminder");
		expect(reminder).toContain("wait_agent");
		expect(reminder).toContain(child.getSessionId());
	});

	test("formats a readable /agents report from derived spawned-agent state", () => {
		const model = getModel("openai", "gpt-5.1-codex");
		if (!model) throw new Error("Expected model to exist");

		const parent = new SessionManager(false, undefined, false, workspacePath);
		parent.startSession({ model, thinkingLevel: "off" } as never);

		const child = new SessionManager(false, undefined, false, workspacePath);
		child.startSession({ model, thinkingLevel: "off" } as never);
		child.saveMessage(buildAssistantMessage("CHILD_GAMMA_DONE"));

		parent.saveMessage(
			buildToolResultMessage("spawn_agent", `Spawned ${child.getSessionId()}`, {
				sessionId: child.getSessionId(),
				sessionFile: child.getSessionFile(),
				effectiveModel: "openai/gpt-5.1-codex",
				effectiveReasoning: "off",
			}),
		);

		const report = formatSpawnedAgentsReport(parent.getSessionFile());
		expect(report).toContain("Spawned Agents");
		expect(report).toContain(child.getSessionId());
		expect(report).toContain("completed");
		expect(report).toContain("unwaited");
		expect(report).toContain("CHILD_GAMMA_DONE");
	});
});
