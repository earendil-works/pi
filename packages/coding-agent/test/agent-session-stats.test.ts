import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	getModel,
	streamSimple,
	type ToolResultMessage,
	type Usage,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getUsageCostBreakdown } from "../src/core/usage-totals.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function createAssistantMessage(text: string, totalTokens: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

function createUserMessage(text: string, timestamp: number) {
	return {
		role: "user" as const,
		content: text,
		timestamp,
	};
}

function createToolResultMessage(usage: Usage): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tool-call-1",
		toolName: "test_tool",
		content: [{ type: "text", text: "tool result" }],
		usage,
		isError: false,
		timestamp: 1,
	};
}

async function createSession() {
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			streamFn: streamSimple,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRuntime: getModelRuntime(await createInMemoryModelRegistry(authStorage)),
		resourceLoader: createTestResourceLoader(),
	});

	return { session, sessionManager };
}

function syncAgentMessages(session: AgentSession, sessionManager: SessionManager): void {
	session.agent.state.messages = sessionManager.buildSessionContext().messages;
}

describe("AgentSession.getSessionStats", () => {
	it("exposes the current context usage alongside token totals", async () => {
		const { session, sessionManager } = await createSession();

		try {
			sessionManager.appendMessage(createUserMessage("hello", 1));
			sessionManager.appendMessage(createAssistantMessage("hi", 200, 2));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.contextUsage).toEqual(session.getContextUsage());
			expect(stats.contextUsage?.tokens).toBe(200);
			expect(stats.contextUsage?.contextWindow).toBe(model.contextWindow);
			expect(stats.contextUsage?.percent).toBe((200 / model.contextWindow) * 100);
		} finally {
			session.dispose();
		}
	});

	it("reports unknown current context usage immediately after compaction", async () => {
		const { session, sessionManager } = await createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2));
			const keptUserId = sessionManager.appendMessage(createUserMessage("second", 3));
			sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4));
			sessionManager.appendCompaction("summary", keptUserId, 195_000);
			sessionManager.appendMessage(createUserMessage("third", 5));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			// Totals cover ALL entries, including history compacted away (180k + 195k).
			expect(stats.tokens.input).toBe(375_000);
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.tokens).toBeNull();
			expect(stats.contextUsage?.percent).toBeNull();
		} finally {
			session.dispose();
		}
	});

	it("uses post-compaction usage for current context instead of stale kept usage", async () => {
		const { session, sessionManager } = await createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2));
			const keptUserId = sessionManager.appendMessage(createUserMessage("second", 3));
			sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4));
			sessionManager.appendCompaction("summary", keptUserId, 195_000);
			sessionManager.appendMessage(createUserMessage("third", 5));
			sessionManager.appendMessage(createAssistantMessage("response3", 25_000, 6));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			// Totals cover ALL entries, including history compacted away (180k + 195k + 25k).
			expect(stats.tokens.input).toBe(400_000);
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.tokens).toBe(25_000);
			expect(stats.contextUsage?.percent).toBe((25_000 / model.contextWindow) * 100);
		} finally {
			session.dispose();
		}
	});

	it("includes branch summary usage in session totals", async () => {
		const { session, sessionManager } = await createSession();

		try {
			sessionManager.branchWithSummary(null, "summary", undefined, false, {
				input: 10,
				output: 20,
				cacheRead: 30,
				cacheWrite: 40,
				totalTokens: 100,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
			});
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.tokens).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 });
			expect(stats.cost).toBe(1);
		} finally {
			session.dispose();
		}
	});

	it("includes compaction usage in session totals", async () => {
		const { session, sessionManager } = await createSession();

		try {
			const firstKeptEntryId = sessionManager.appendMessage(createUserMessage("hello", 1));
			sessionManager.appendCompaction("summary", firstKeptEntryId, 100, undefined, false, {
				input: 10,
				output: 20,
				cacheRead: 30,
				cacheWrite: 40,
				totalTokens: 100,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
			});
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.tokens).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 });
			expect(stats.cost).toBe(1);
		} finally {
			session.dispose();
		}
	});

	it("includes tool result usage in session totals", async () => {
		const { session, sessionManager } = await createSession();

		try {
			sessionManager.appendMessage(
				createToolResultMessage({
					input: 10,
					output: 20,
					cacheRead: 30,
					cacheWrite: 40,
					totalTokens: 100,
					cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
				}),
			);
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.tokens).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 });
			expect(stats.cost).toBe(1);
		} finally {
			session.dispose();
		}
	});

	it("groups tool and summary usage separately from model-attributed usage", () => {
		const sessionManager = SessionManager.inMemory();
		const rootId = sessionManager.appendMessage(createUserMessage("hello", 1));
		sessionManager.appendMessage({
			...createAssistantMessage("response", 100, 2),
			usage: { ...createUsage(100), cost: { ...createUsage(100).cost, total: 0.5 } },
		});
		sessionManager.appendMessage(
			createToolResultMessage({ ...createUsage(100), cost: { ...createUsage(100).cost, total: 1 } }),
		);
		sessionManager.appendCompaction("summary", rootId, 100, undefined, false, {
			...createUsage(100),
			cost: { ...createUsage(100).cost, total: 2 },
		});
		sessionManager.branchWithSummary(null, "branch summary", undefined, false, {
			...createUsage(100),
			cost: { ...createUsage(100).cost, total: 3 },
		});

		expect(getUsageCostBreakdown(sessionManager.getEntries())).toEqual([
			{ key: "Tools/summaries", cost: 6, tokens: 300 },
			{ key: `${model.provider}/${model.id}`, cost: 0.5, tokens: 100 },
		]);
	});

	it("ignores zero-usage messages when checking for post-compaction context usage", async () => {
		const { session, sessionManager } = await createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2));
			const keptUserId = sessionManager.appendMessage(createUserMessage("second", 3));
			sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4));
			sessionManager.appendCompaction("summary", keptUserId, 195_000);
			sessionManager.appendMessage(createUserMessage("third", 5));
			sessionManager.appendMessage(createAssistantMessage("response3", 25_000, 6));
			sessionManager.appendMessage(createUserMessage("continue", 7));
			sessionManager.appendMessage(createAssistantMessage("partial", 0, 8));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.tokens).not.toBeNull();
			expect(stats.contextUsage?.tokens ?? 0).toBeGreaterThan(25_000);
		} finally {
			session.dispose();
		}
	});
});
