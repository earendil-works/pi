import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, getModel, type StopReason } from "@kennyfrc/mu-ai";
import { TypeGuard } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getToolDescription } from "../src/prompts/index.js";
import { setCurrentModel, setCurrentThinkingLevel } from "../src/runtime-state.js";
import { SessionManager } from "../src/session-manager.js";
import { allTools } from "../src/tools/index.js";
import { resolveToolSelection } from "../src/tools/tool-selection.js";

interface WaitAgentToolLike {
	name?: string;
	parameters?: unknown;
	execute?: (
		toolCallId: string,
		args: { ids: string[]; timeoutMs?: number },
		signal?: AbortSignal,
	) => Promise<WaitAgentExecuteResult>;
}

interface WaitAgentExecuteResult {
	content: Array<{ type: "text"; text: string }>;
	details?: {
		results?: Array<{
			sessionId?: string;
			status?: string;
			stopReason?: string;
			text?: string;
		}>;
	};
	isError?: boolean;
}

const workspacePath = "/Users/kennyfrc/Documents/code/work/pi-mono";

function buildAssistantMessage(text: string, stopReason: StopReason = "stop"): AssistantMessage {
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

function createChildSession(): SessionManager {
	const manager = new SessionManager(false, undefined, false, workspacePath);
	const model = getModel("openai", "gpt-5.1-codex");
	if (!model) {
		throw new Error("Expected openai/gpt-5.1-codex model to exist");
	}
	manager.startSession({ model, thinkingLevel: "off" } as never);
	return manager;
}

describe("wait_agent red suite", () => {
	let configDir: string;
	let previousConfigDir: string | undefined;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "mu-wait-agent-red-"));
		previousConfigDir = process.env.MU_CODING_AGENT_DIR;
		process.env.MU_CODING_AGENT_DIR = configDir;

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
		rmSync(configDir, { recursive: true, force: true });
	});

	test("registers a built-in wait_agent tool with ids/timeoutMs parameters", () => {
		const toolMap = allTools as Record<string, unknown>;
		const waitAgentTool = toolMap.wait_agent as WaitAgentToolLike | undefined;

		expect(waitAgentTool).toBeDefined();
		expect(waitAgentTool?.name).toBe("wait_agent");
		expect(TypeGuard.IsObject(waitAgentTool?.parameters)).toBe(true);

		if (!waitAgentTool || !TypeGuard.IsObject(waitAgentTool.parameters)) {
			return;
		}

		const properties = (waitAgentTool.parameters as { properties?: Record<string, unknown> }).properties;
		expect(properties).toBeDefined();
		expect(properties).toHaveProperty("ids");
		expect(properties).toHaveProperty("timeoutMs");
	});

	test("default tool selections include wait_agent", () => {
		const gptModel = getModel("openai", "gpt-5.1-codex");
		const regularModel = getModel("anthropic", "claude-sonnet-4-5");
		expect(gptModel).toBeDefined();
		expect(regularModel).toBeDefined();

		expect(resolveToolSelection(undefined, gptModel!).toolNames as string[]).toContain("wait_agent");
		expect(resolveToolSelection(undefined, regularModel!).toolNames as string[]).toContain("wait_agent");
	});

	test("spawn_agent description tells the model to follow with wait_agent and parallelize waits for multiple children", () => {
		const description = getToolDescription("spawn_agent");

		expect(description).toContain("wait_agent");
		expect(description).toMatch(/after spawning|once .*spawn/i);
		expect(description).toMatch(/parallel/i);
	});

	test("waits for a child session to finish and returns its final assistant response", async () => {
		const toolMap = allTools as Record<string, unknown>;
		const waitAgentTool = toolMap.wait_agent as WaitAgentToolLike | undefined;
		expect(waitAgentTool?.execute).toBeDefined();

		if (!waitAgentTool?.execute) {
			return;
		}

		const child = createChildSession();
		const childSessionId = child.getSessionId();

		const timer = setTimeout(() => {
			child.saveMessage(buildAssistantMessage("CHILD_OK"));
		}, 150);

		const startedAt = Date.now();
		const result = await waitAgentTool.execute("toolcall_wait_single", { ids: [childSessionId], timeoutMs: 2_000 });
		const elapsedMs = Date.now() - startedAt;
		clearTimeout(timer);

		expect(result.isError).not.toBe(true);
		expect(elapsedMs).toBeGreaterThanOrEqual(100);
		expect(result.content.map((block) => block.text).join("\n")).toContain("CHILD_OK");
		expect(result.details?.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sessionId: childSessionId,
					status: "completed",
					stopReason: "stop",
					text: expect.stringContaining("CHILD_OK"),
				}),
			]),
		);
	});

	test("returns one completed result per child when waiting on multiple child sessions", async () => {
		const toolMap = allTools as Record<string, unknown>;
		const waitAgentTool = toolMap.wait_agent as WaitAgentToolLike | undefined;
		expect(waitAgentTool?.execute).toBeDefined();

		if (!waitAgentTool?.execute) {
			return;
		}

		const childA = createChildSession();
		const childB = createChildSession();
		childA.saveMessage(buildAssistantMessage("ALPHA_DONE"));
		childB.saveMessage(buildAssistantMessage("BETA_DONE"));

		const result = await waitAgentTool.execute("toolcall_wait_many", {
			ids: [childA.getSessionId(), childB.getSessionId()],
			timeoutMs: 2_000,
		});

		expect(result.isError).not.toBe(true);
		expect(result.details?.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sessionId: childA.getSessionId(),
					status: "completed",
					stopReason: "stop",
					text: expect.stringContaining("ALPHA_DONE"),
				}),
				expect.objectContaining({
					sessionId: childB.getSessionId(),
					status: "completed",
					stopReason: "stop",
					text: expect.stringContaining("BETA_DONE"),
				}),
			]),
		);
	});
});
