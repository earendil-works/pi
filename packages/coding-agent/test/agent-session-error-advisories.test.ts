import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Message,
	type TextContent,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { buildAdvisedErrorSkipSet, isAdvisoryCustomMessage, populateContentFromErrorMessage } from "../src/core/sdk.ts";
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

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
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
		...overrides,
	};
}

describe("AgentSession error advisories", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-advisory-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession(options?: { failCount?: number; maxRetries?: number }) {
		const failCount = options?.failCount ?? 1;
		const maxRetries = options?.maxRetries ?? 1;
		let callCount = 0;

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount <= failCount) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		return { session, getCallCount: () => callCount };
	}

	it("injects auto_retry_exhausted advisory without auto-continuing (H2)", async () => {
		// When retries are exhausted, the session must inject a user-role advisory
		// and NOT trigger an infinite retry loop with a fresh budget.
		// failCount: 2 = initial prompt + 1 retry both fail; follow-up (call 3) succeeds.
		const created = createSession({ failCount: 2, maxRetries: 1 });
		await created.session.prompt("Test");

		const messages = created.session.state.messages;
		const advisory = messages.find((m) => m.role === "custom" && (m as any).customType === "auto_retry_exhausted");
		expect(advisory).toBeDefined();
		// The advisory must be visible to the LLM as a user-role message
		expect(advisory!.role).toBe("custom");

		// Agent must NOT be retrying or streaming (no infinite loop)
		expect(created.session.isRetrying).toBe(false);
		expect(created.session.isStreaming).toBe(false);

		// A follow-up prompt must work (loop terminated cleanly)
		await created.session.prompt("Follow-up");
		expect(created.getCallCount()).toBe(3); // initial fail + retry fail + follow-up
	});

	it("does not inject auto_retry_exhausted advisory when retry succeeds", async () => {
		const created = createSession({ failCount: 1, maxRetries: 3 });
		await created.session.prompt("Test");

		const messages = created.session.state.messages;
		const advisory = messages.find((m) => m.role === "custom" && (m as any).customType === "auto_retry_exhausted");
		expect(advisory).toBeUndefined();
	});
});

describe("convertToLlm error message serialization", () => {
	it("populates content from errorMessage so error messages survive pi-ai serialization", () => {
		// pi-ai's anthropic-messages serializer drops assistant messages with empty
		// content (anthropic-messages.js:816,868). The SDK wrapper must populate
		// content from errorMessage so these messages are not silently lost.
		const errorAssistant = createAssistantMessage("", {
			stopReason: "error",
			errorMessage: "overloaded_error: rate limit exceeded",
		});

		// Raw convertToLlm passes the message through unchanged (empty content)
		const rawConverted = convertToLlm([errorAssistant]);
		expect(rawConverted[0].role).toBe("assistant");
		// The raw conversion preserves empty content — the SDK layer handles population
		expect((rawConverted[0] as AssistantMessage).content).toEqual([{ type: "text", text: "" }]);
	});

	it("preserves error messages with existing content", () => {
		const msgWithContent = createAssistantMessage("Partial response before error", {
			stopReason: "error",
			errorMessage: "timeout_error",
		});

		const converted = convertToLlm([msgWithContent]);
		expect(converted[0].role).toBe("assistant");
		expect((converted[0] as AssistantMessage).content).toEqual([
			{ type: "text", text: "Partial response before error" },
		]);
	});

	it("replaces an unconvertible message with a placeholder instead of throwing (🔴-4 / H3)", () => {
		// A malformed message whose getter throws must not kill the entire turn.
		// convertToLlm catches per-message and substitutes a placeholder so the
		// poison entry is dropped (and won't re-throw on the next turn).
		const poison = {
			get role() {
				throw new Error("corrupt role accessor");
			},
			get timestamp() {
				return 1234;
			},
		} as unknown as AssistantMessage;

		const converted = convertToLlm([poison]);
		expect(converted).toHaveLength(1);
		expect(converted[0].role).toBe("user");
		expect((converted[0].content[0] as TextContent).text).toMatch(
			/Conversation history note: a unknown message could not be included due to a conversion error: corrupt role accessor/,
		);
		expect(converted[0].timestamp).toBe(1234);
	});
});

describe("populateContentFromErrorMessage (sdk.ts extracted helper)", () => {
	it("populates content from errorMessage when content is empty", () => {
		const msg = createAssistantMessage("", {
			stopReason: "error",
			errorMessage: "overloaded_error: rate limit exceeded",
		});

		const result = populateContentFromErrorMessage(msg);
		expect((result as AssistantMessage).content).toEqual([
			{ type: "text", text: "overloaded_error: rate limit exceeded" },
		]);
	});

	it("populates content when content has only whitespace text", () => {
		const msg = createAssistantMessage("   ", {
			stopReason: "error",
			errorMessage: "timeout_error",
		});

		const result = populateContentFromErrorMessage(msg);
		expect((result as AssistantMessage).content).toEqual([{ type: "text", text: "timeout_error" }]);
	});

	it("leaves messages with existing non-empty content untouched", () => {
		const msg = createAssistantMessage("Partial response before error", {
			stopReason: "error",
			errorMessage: "timeout_error",
		});

		const result = populateContentFromErrorMessage(msg);
		expect((result as AssistantMessage).content).toEqual([{ type: "text", text: "Partial response before error" }]);
	});

	it("does not touch non-error assistant messages", () => {
		const msg = createAssistantMessage("All good");
		const result = populateContentFromErrorMessage(msg);
		expect(result).toBe(msg);
	});

	it("does not touch error messages with no errorMessage", () => {
		const msg = createAssistantMessage("", { stopReason: "error" });
		const result = populateContentFromErrorMessage(msg);
		expect(result).toBe(msg);
	});

	it("does not touch non-assistant messages", () => {
		const userMsg = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "hi" }],
			timestamp: Date.now(),
		};
		const result = populateContentFromErrorMessage(userMsg);
		expect(result).toBe(userMsg);
	});
});

describe("buildAdvisedErrorSkipSet / isAdvisoryCustomMessage (H5: no errorMessage mutation)", () => {
	it("classifies injected advisories and not regular custom messages", () => {
		expect(isAdvisoryCustomMessage({ role: "custom", customType: "auto_retry_exhausted" })).toBe(true);
		expect(isAdvisoryCustomMessage({ role: "custom", customType: "overflow_recovery_exhausted" })).toBe(true);
		expect(isAdvisoryCustomMessage({ role: "custom", customType: "some_extension_note" })).toBe(false);
		expect(isAdvisoryCustomMessage({ role: "user" })).toBe(false);
	});

	it("marks an error assistant message to skip when directly followed by an advisory", () => {
		const errorAssistant = createAssistantMessage("", {
			stopReason: "error",
			errorMessage: "overloaded_error",
		});
		const advisory = {
			role: "custom" as const,
			customType: "auto_retry_exhausted",
			content: [{ type: "text" as const, text: "failed" }] as never,
			display: true,
			timestamp: Date.now(),
		};

		const skip = buildAdvisedErrorSkipSet([errorAssistant, advisory]);
		expect(skip.has(errorAssistant as unknown as Message)).toBe(true);
	});

	it("does not mark an error message followed by a non-advisory message", () => {
		const errorAssistant = createAssistantMessage("", {
			stopReason: "error",
			errorMessage: "overloaded_error",
		});
		const regularUser = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "hi" }],
			timestamp: Date.now(),
		};

		const skip = buildAdvisedErrorSkipSet([errorAssistant, regularUser]);
		expect(skip.has(errorAssistant as unknown as Message)).toBe(false);
	});

	it("only considers immediately adjacent messages", () => {
		const errorAssistant = createAssistantMessage("", {
			stopReason: "error",
			errorMessage: "overloaded_error",
		});
		const gap = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "between" }],
			timestamp: Date.now(),
		};
		const advisory = {
			role: "custom" as const,
			customType: "compaction_failed",
			content: [{ type: "text" as const, text: "failed" }] as never,
			display: true,
			timestamp: Date.now() + 1,
		};

		const skip = buildAdvisedErrorSkipSet([errorAssistant, gap, advisory]);
		expect(skip.has(errorAssistant as unknown as Message)).toBe(false);
	});
});
