/**
 * Tests for AgentSession.dispose() aborting the agent's in-flight call.
 *
 * Discovered by PIRA (PI Remote Access). When `switchSession` /
 * `newSession` / `fork` / `clone` run while a previous LLM call is
 * mid-stream, the path is:
 *
 *   runtimeHost.switchSession(path)
 *     → emitBeforeSwitch(...)
 *     → SessionManager.open(path, ...)
 *     → teardownCurrent(...)
 *         → session.dispose()        <-- here
 *             → _disconnectFromAgent() (removes our event listener)
 *             → cleanupSessionResources(...)
 *     → createRuntime(...) (brand new agent at same path)
 *
 * Before this fix, `dispose()` removed the event listener but did NOT
 * abort the agent. The previous agent's in-flight fetch() to the LLM
 * provider continued running in the background until the provider
 * responded — orphaned socket, wasted provider quota, and external
 * observers (PIRA, other hosts) seeing pi at 0 % CPU with one
 * ESTABLISHED HTTPS socket and no events flowing, indistinguishable
 * from a wedged process.
 *
 * Fix: synchronous `this.agent.abort()` at the top of `dispose()`,
 * wrapped in try/catch so dispose remains exception-safe. The abort
 * trips the AbortController immediately; the fetch rejection lands
 * asynchronously after dispose returns. Keeps dispose() synchronous.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
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

function createAssistantMessage(text: string): AssistantMessage {
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
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentSession.dispose aborts in-flight call", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dispose-abort-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			try {
				session.dispose();
			} catch {
				// already disposed inside the test
			}
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession(): { session: AgentSession; getAbortSignal: () => AbortSignal | undefined } {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let abortSignal: AbortSignal | undefined;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, _context, options) => {
				// Capture the signal so the test can assert on it after
				// dispose. The stream stays "live" (never resolves) until
				// the signal aborts, mirroring a real LLM HTTP call.
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({
								type: "error",
								reason: "aborted",
								error: createAssistantMessage("Aborted"),
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
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		return { session, getAbortSignal: () => abortSignal };
	}

	it("trips the agent's abort signal when dispose() is called mid-stream", async () => {
		const { session, getAbortSignal } = createSession();

		// Start a prompt; intentionally don't await — the mock stream
		// won't resolve until the signal aborts.
		const inflight = session.prompt("Long-running prompt").catch(() => {
			/* expected: rejects with abort */
		});

		// Wait a microtask cycle so the streamFn runs and captures the signal.
		await new Promise((resolve) => setTimeout(resolve, 20));
		const signalBefore = getAbortSignal();
		expect(signalBefore, "stream should have started and captured an AbortSignal").toBeDefined();
		expect(signalBefore!.aborted).toBe(false);
		expect(session.isStreaming).toBe(true);

		// THIS is the behaviour under test.
		session.dispose();

		// AbortController.abort() is synchronous: the signal trips
		// immediately even though the fetch rejection lands later.
		expect(signalBefore!.aborted).toBe(true);

		// Let the in-flight promise settle (it'll reject with the
		// "aborted" error we queued up in the mock streamFn).
		await inflight;
	});

	it("calls agent.abort() exactly once during dispose()", async () => {
		const { session } = createSession();
		const abortSpy = vi.spyOn(session.agent, "abort");

		session.dispose();

		expect(abortSpy).toHaveBeenCalledOnce();
	});

	it("does not throw when agent.abort() throws", () => {
		const { session } = createSession();
		vi.spyOn(session.agent, "abort").mockImplementation(() => {
			throw new Error("simulated abort failure");
		});

		// The whole point of the try/catch is keeping dispose
		// exception-safe — a dispose path that can throw blocks
		// session teardown across the entire host.
		expect(() => session.dispose()).not.toThrow();
	});

	it("still tears down listeners + cleans up resources after abort", () => {
		const { session } = createSession();

		// Sanity: a fresh session has its agent listener wired.
		// (We don't have a public accessor for the unsubscribe
		// function, so this is checked indirectly via dispose
		// not throwing and not leaving the session in a half-state.)
		session.dispose();

		// Calling dispose() a second time should be safe — _disconnectFromAgent
		// is idempotent, and the abort() inside the try/catch can run again
		// without consequences (AbortController.abort() on an already-aborted
		// controller is a no-op).
		expect(() => session.dispose()).not.toThrow();
	});
});
