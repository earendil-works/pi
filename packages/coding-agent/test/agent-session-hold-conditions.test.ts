/**
 * Tests for AgentSession.waitForPendingWork() — hold condition error handling.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ExtensionRunner } from "../src/core/extensions/runner.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

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

type SessionInternals = {
	_holdConditions: Array<() => Promise<string[]>>;
	_extensionRunner: ExtensionRunner | undefined;
};

describe("AgentSession hold conditions", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-hold-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) session.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function createSession() {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const msg: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
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
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		return session;
	}

	it("resolves immediately when no hold conditions are registered", async () => {
		createSession();
		await session.waitForPendingWork();
	});

	it("resolves when all hold conditions return empty arrays", async () => {
		createSession();
		const internals = session as unknown as SessionInternals;
		internals._holdConditions.push(async () => []);
		internals._holdConditions.push(async () => []);
		await session.waitForPendingWork();
	});

	it("catches throwing hold condition and routes through emitError", async () => {
		createSession();
		const internals = session as unknown as SessionInternals;

		const emitError = vi.fn();
		internals._extensionRunner = { emitError } as unknown as ExtensionRunner;

		internals._holdConditions.push(async () => {
			throw new Error("boom");
		});

		await session.waitForPendingWork();

		expect(emitError).toHaveBeenCalledOnce();
		expect(emitError).toHaveBeenCalledWith(
			expect.objectContaining({
				extensionPath: "<hold-condition>",
				event: "hold_condition",
				error: "boom",
			}),
		);
	});

	it("does not block on a throwing condition when other conditions resolve", async () => {
		createSession();
		const internals = session as unknown as SessionInternals;

		const emitError = vi.fn();
		internals._extensionRunner = { emitError } as unknown as ExtensionRunner;

		const goodCondition = vi.fn().mockResolvedValue([]);
		internals._holdConditions.push(async () => {
			throw new Error("fail");
		});
		internals._holdConditions.push(goodCondition);

		await session.waitForPendingWork();

		expect(goodCondition).toHaveBeenCalled();
		expect(emitError).toHaveBeenCalledOnce();
	});
});
