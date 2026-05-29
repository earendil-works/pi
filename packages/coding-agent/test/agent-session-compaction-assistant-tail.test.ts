/**
 * Regression tests for: compaction leaving assistant-tailed context that crashes continue()
 *
 * Covers two bugs:
 * 1. Silent overflow: stopReason "stop" with usage exceeding context leaves a trailing
 *    assistant that is not trimmed by the willRetry path (which only checked stopReason "error").
 * 2. Queue race: after compaction, hasQueuedMessages() can return true, but queues drain
 *    before continue() runs, causing "Cannot continue from message role: assistant".
 *
 * Both are fixed by:
 * - _continueAgentIfPossible() guard that skips continue() when tail is assistant and no
 *   queued messages exist
 * - Broadened willRetry trim to remove ANY trailing assistant, not just error ones
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

vi.mock("../src/core/compaction/index.js", () => ({
	calculateContextTokens: (usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens?: number;
	}) => usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	compact: async () => ({
		summary: "compacted",
		firstKeptEntryId: "entry-1",
		tokensBefore: 100,
		details: {},
	}),
	estimateContextTokens: (
		messages: Array<{
			role: string;
			usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number };
			stopReason?: string;
		}>,
	) => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant" && msg.stopReason !== "error" && msg.stopReason !== "aborted" && msg.usage) {
				const tokens =
					msg.usage.totalTokens ?? msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
				return { tokens, usageTokens: tokens, trailingTokens: 0, lastUsageIndex: i };
			}
		}
		return { tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null };
	},
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompaction: () => ({ dummy: true }),
	shouldCompact: (
		contextTokens: number,
		contextWindow: number,
		settings: { enabled: boolean; reserveTokens: number },
	) => settings.enabled && contextTokens > contextWindow - settings.reserveTokens,
}));

describe("AgentSession compaction assistant-tail guard", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-compaction-tail-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		vi.useFakeTimers();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});

		sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("should trim any trailing assistant in willRetry path, not just error ones", async () => {
		// Simulate a silent overflow: stopReason "stop" but assistant message at tail
		const model = session.model!;
		const silentOverflowAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 500_000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 501_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop", // NOT "error" — this is the silent overflow case
			timestamp: Date.now(),
		};

		// Set up agent state with assistant at tail
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			silentOverflowAssistant,
		];

		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
			}
		)._runAutoCompaction.bind(session);

		const result = await runAutoCompaction("overflow", true);

		expect(result).toBe(true);
		// The trailing assistant should have been trimmed regardless of stopReason
		const lastMsg = session.agent.state.messages[session.agent.state.messages.length - 1];
		expect(lastMsg?.role).not.toBe("assistant");
	});

	it("should not throw when continuing after compaction leaves assistant tail with no queued messages", async () => {
		// After compaction, context ends with assistant and no queued messages
		const model = session.model!;
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			{
				role: "assistant",
				content: [{ type: "text", text: "compacted context here" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 10,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		// No queued messages — this is the crash scenario
		expect(session.agent.hasQueuedMessages()).toBe(false);

		const continueAgentIfPossible = (
			session as unknown as {
				_continueAgentIfPossible: () => Promise<void>;
			}
		)._continueAgentIfPossible.bind(session);

		// Should NOT throw "Cannot continue from message role: assistant"
		await expect(continueAgentIfPossible()).resolves.toBeUndefined();
	});

	it("should still continue when queued messages exist despite assistant tail", async () => {
		const model = session.model!;
		session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			{
				role: "assistant",
				content: [{ type: "text", text: "response" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 10,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		// Queue a follow-up message — this should allow continue() to proceed
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued follow-up" }],
			display: false,
			timestamp: Date.now(),
		});
		expect(session.agent.hasQueuedMessages()).toBe(true);

		// Mock runPromptMessages so we don't need a real LLM
		const runPromptMessagesSpy = vi
			.spyOn(
				session.agent as unknown as {
					runPromptMessages: (msgs: unknown[], opts?: unknown) => Promise<void>;
				},
				"runPromptMessages",
			)
			.mockResolvedValue(undefined);

		const continueAgentIfPossible = (
			session as unknown as {
				_continueAgentIfPossible: () => Promise<void>;
			}
		)._continueAgentIfPossible.bind(session);

		await continueAgentIfPossible();
		expect(runPromptMessagesSpy).toHaveBeenCalled();
	});
});
