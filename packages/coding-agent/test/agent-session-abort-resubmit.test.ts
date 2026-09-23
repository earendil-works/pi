import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
/**
 * Tests for resubmitting while a run is unwinding from a user abort.
 *
 * Escape during streaming aborts the run and restores queued text to the
 * editor; pressing Enter before the run settles must not steer into the
 * dying run (whose queues are never drained) but become a fresh prompt.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
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

function createAssistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("AgentSession resubmit during abort unwind", () => {
	let session: AgentSession;
	let tempDir: string;
	/** User texts each streamFn call actually received. */
	let seenUserTexts: string[][];

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-abort-resubmit-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		seenUserTexts = [];
	});

	afterEach(async () => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession() {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let abortSignal: AbortSignal | undefined;
		let callCount = 0;

		// First call blocks until aborted (the run the user escapes from); every
		// later call completes immediately with a plain assistant reply.
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, context, options) => {
				abortSignal = options?.signal;
				const call = ++callCount;
				seenUserTexts.push(
					context.messages
						.filter((message) => message.role === "user")
						.map((message) =>
							typeof message.content === "string"
								? message.content
								: message.content
										.filter((part) => part.type === "text")
										.map((part) => (part as { type: "text"; text: string }).text)
										.join(" "),
						),
				);
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (call > 1) {
						stream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage(`Reply ${call}`),
						});
						return;
					}
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({
								type: "error",
								reason: "aborted",
								error: createAssistantMessage("Aborted", "aborted"),
							});
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({
			type: "api_key",
			key: "test-key",
		}));

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		return session;
	}

	it("turns a steer submitted during abort unwind into a fresh prompt", async () => {
		await createSession();

		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(session.isStreaming).toBe(true);

		// Escape: abort the run the way interactive-mode does (voided, not awaited).
		void session.abort();

		// Quick Enter: prompt with steer behavior while the run is still settling.
		const resubmit = session.prompt("Restored message", {
			streamingBehavior: "steer",
		});

		await firstPrompt.catch(() => {});
		await resubmit;
		console.log(
			"SEEN",
			JSON.stringify(seenUserTexts),
			"PENDING",
			session.pendingMessageCount,
			"STREAMING",
			session.isStreaming,
		);

		// The resubmitted text must reach the model as its own run, not sit in a queue
		// the aborted run never drains.
		expect(session.pendingMessageCount).toBe(0);
		expect(seenUserTexts.length).toBeGreaterThanOrEqual(2);
		expect(seenUserTexts[1]).toContain("Restored message");
	});

	it("still steers into a live (non-aborted) run", async () => {
		await createSession();

		const firstPrompt = session.prompt("First message");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(session.isStreaming).toBe(true);

		await session.prompt("Steering message", { streamingBehavior: "steer" });
		expect(session.pendingMessageCount).toBe(1);

		await session.abort();
		await firstPrompt.catch(() => {});
	});
});
