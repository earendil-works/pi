import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
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

describe("AgentSession external tool results", () => {
	let tempDir: string | undefined;
	let session: AgentSession | undefined;

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		tempDir = undefined;
	});

	it("persists, resumes, and idempotently resolves a deferred external tool call", async () => {
		tempDir = join(tmpdir(), `pi-external-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let responseIndex = 0;
		const agent = new Agent({
			initialState: { model, systemPrompt: "test", thinkingLevel: "off", tools: [] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message =
						responseIndex++ === 0
							? assistantMessage(
									[
										{
											type: "toolCall",
											id: "approval-1",
											name: "wait_for_approval",
											arguments: { action: "deploy" },
										},
									],
									"toolUse",
								)
							: assistantMessage([{ type: "text", text: "Deployment approved." }], "stop");
					stream.push({ type: "done", reason: responseIndex === 1 ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		const sessionDir = join(tempDir, "sessions");
		const sessionManager = SessionManager.create(tempDir, sessionDir, { id: "external-tool-result" });
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
			customTools: [
				{
					name: "wait_for_approval",
					label: "Wait for approval",
					description: "Wait for an external approval.",
					parameters: Type.Object({ action: Type.String() }),
					execute: async () => ({
						content: [{ type: "text", text: "Waiting for approval." }],
						details: {},
						defer: true,
					}),
				},
			],
		});

		await session.prompt("Deploy the service.");
		expect(session.listPendingExternalToolCalls()).toEqual([
			expect.objectContaining({
				toolCallId: "approval-1",
				toolName: "wait_for_approval",
				args: { action: "deploy" },
			}),
		]);
		expect(session.state.messages.some((message) => message.role === "toolResult")).toBe(false);
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();

		session.dispose();
		const restoredManager = SessionManager.open(sessionFile!, sessionDir);
		const restoredContext = restoredManager.buildSessionContext();
		const restoredAgent = new Agent({
			initialState: {
				model,
				systemPrompt: "test",
				thinkingLevel: "off",
				tools: [],
				messages: restoredContext.messages,
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message = assistantMessage([{ type: "text", text: "Deployment approved." }], "stop");
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent: restoredAgent,
			sessionManager: restoredManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		expect(session.listPendingExternalToolCalls()).toEqual([
			expect.objectContaining({
				toolCallId: "approval-1",
				toolName: "wait_for_approval",
				args: { action: "deploy" },
			}),
		]);
		await expect(
			session.submitExternalToolResult({
				toolCallId: "not-pending",
				content: [{ type: "text", text: "Nope." }],
				details: {},
			}),
		).rejects.toThrow("No pending external tool call found");

		await expect(
			session.submitExternalToolResult({
				toolCallId: "approval-1",
				content: [{ type: "text", text: "Approved by the project owner." }],
				details: { approved: true },
			}),
		).resolves.toEqual({ status: "resumed" });

		expect(session.listPendingExternalToolCalls()).toEqual([]);
		expect(
			session.state.messages.some((message) => message.role === "toolResult" && message.toolCallId === "approval-1"),
		).toBe(true);
		expect(session.state.messages.at(-1)).toMatchObject({ role: "assistant" });
		await expect(
			session.submitExternalToolResult({
				toolCallId: "approval-1",
				content: [{ type: "text", text: "Duplicate." }],
				details: {},
			}),
		).resolves.toEqual({ status: "already_resolved" });
	});
});
