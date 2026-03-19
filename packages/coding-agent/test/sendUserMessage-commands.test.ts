/**
 * Tests for sendUserMessage() slash command dispatch (Fix #2023).
 *
 * VAL-EXT-001: sendUserMessage("/command") dispatches to registered command handler
 * VAL-EXT-002: sendUserMessage("regular text") still goes to prompt()
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
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

describe("sendUserMessage slash command dispatch", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sendUserMessage-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
	});

	function createSession() {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, _context, _options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("response") });
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

	it("dispatches slash commands to _tryExecuteExtensionCommand (VAL-EXT-001)", async () => {
		const s = createSession();

		const tryExecuteSpy = vi
			.spyOn(s as never, "_tryExecuteExtensionCommand" as never)
			.mockResolvedValue(true as never);
		const promptSpy = vi.spyOn(AgentSession.prototype, "prompt").mockResolvedValue(undefined);

		await s.sendUserMessage("/some-command arg1 arg2");

		expect(tryExecuteSpy).toHaveBeenCalledWith("/some-command arg1 arg2");
		expect(promptSpy).not.toHaveBeenCalled();
	});

	it("falls through to prompt() when command is not handled (VAL-EXT-001)", async () => {
		const s = createSession();

		const tryExecuteSpy = vi
			.spyOn(s as never, "_tryExecuteExtensionCommand" as never)
			.mockResolvedValue(false as never);
		const promptSpy = vi.spyOn(AgentSession.prototype, "prompt").mockResolvedValue(undefined);

		await s.sendUserMessage("/unknown-command");

		expect(tryExecuteSpy).toHaveBeenCalledWith("/unknown-command");
		expect(promptSpy).toHaveBeenCalled();
	});

	it("sends non-slash text directly to prompt() without command dispatch (VAL-EXT-002)", async () => {
		const s = createSession();

		const tryExecuteSpy = vi
			.spyOn(s as never, "_tryExecuteExtensionCommand" as never)
			.mockResolvedValue(false as never);
		const promptSpy = vi.spyOn(AgentSession.prototype, "prompt").mockResolvedValue(undefined);

		await s.sendUserMessage("regular text without slash");

		expect(tryExecuteSpy).not.toHaveBeenCalled();
		expect(promptSpy).toHaveBeenCalled();
	});
});
