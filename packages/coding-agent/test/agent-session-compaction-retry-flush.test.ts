import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

/**
 * Regression test for https://github.com/earendil-works/pi/issues/9051
 *
 * A session_compact handler that republishes state with
 * sendCustomMessage(..., { triggerTurn: false }) defers the message to the
 * end of the turn while streaming. The immediate overflow retry must not run
 * without that restored context: _runAutoCompaction("overflow", true) has to
 * flush pending custom messages into agent state and session history before
 * the interrupted turn continues.
 */
describe("AgentSession overflow retry flushes session_compact custom messages", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settingsManager: SettingsManager;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-compact-flush-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			streamFn: streamSimple,
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});

		sessionManager = SessionManager.inMemory();
		settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("includes passive custom messages published by session_compact in the overflow retry", async () => {
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const model = session.model!;
		const now = Date.now();
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "assistant response to compact" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now - 500,
		});
		session.agent.state.messages = sessionManager.buildSessionContext().messages;

		session.agent.streamFunction = (summaryModel) => {
			const stream = createAssistantMessageEventStream();
			void Promise.resolve().then(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("compacted"),
						api: summaryModel.api,
						provider: summaryModel.provider,
						model: summaryModel.id,
						usage: {
							input: 10,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 10,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				});
			});
			return stream;
		};

		// An extension republishing exact state after compaction: a passive
		// custom message sent while the (failed) turn is still active.
		(session as unknown as { _extensionRunner: object })._extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_compact",
			invalidate: () => {},
			emit: async (event: { type: string }) => {
				if (event.type === "session_compact") {
					await session.sendCustomMessage(
						{
							customType: "restored_context",
							content: [{ type: "text", text: "RESTORED_CONTEXT_MARKER" }],
							display: false,
						},
						{ triggerTurn: false },
					);
				}
				return undefined;
			},
		};

		// The overflow path runs inside the agent run loop, i.e. while
		// isStreaming is true — that is exactly why sendCustomMessage defers.
		(session as unknown as { _isAgentRunActive: boolean })._isAgentRunActive = true;

		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
			}
		)._runAutoCompaction.bind(session);

		await expect(runAutoCompaction("overflow", true)).resolves.toBe(true);

		// The restored context must have left the deferred queue...
		const pending = (session as unknown as { _pendingCustomMessages: unknown[] })._pendingCustomMessages;
		expect(pending).toHaveLength(0);
		// ...and be part of the state the immediate retry sends.
		const messages = session.agent.state.messages;
		const restored = messages.find(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === "restored_context",
		);
		expect(restored).toBeDefined();
		expect(messages[messages.length - 1]).toBe(restored);
	});
});
