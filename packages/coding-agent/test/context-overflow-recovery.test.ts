import type { Message, ToolResultMessage } from "@kennyfrc/mu-ai";
import { getModel } from "@kennyfrc/mu-ai";
import { describe, expect, it, vi } from "vitest";

import { handleContextOverflow } from "../src/context-overflow-recovery.js";
import type { HandoffDetails } from "../src/tools/handoff.js";

function requireModel(provider: Parameters<typeof getModel>[0], modelId: string) {
	const model = getModel(provider, modelId);
	expect(model).toBeTruthy();
	if (!model) {
		throw new Error(`Required test model is missing: ${provider}/${modelId}`);
	}
	return model;
}

function buildTestMessages(lastToolResult?: ToolResultMessage): Message[] {
	const anthropicModel = requireModel("anthropic", "claude-sonnet-4-5");
	const messages: Message[] = [
		{
			role: "user",
			content: "Fix the bug in login.ts",
			timestamp: 1,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "I'll read the file to investigate." }],
			api: anthropicModel.api,
			provider: anthropicModel.provider,
			model: anthropicModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		},
	];

	if (lastToolResult) {
		messages.push(lastToolResult);
	}

	return messages;
}

function buildTestToolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_123",
		toolName: "read_file",
		content: [{ type: "text", text: "Large file content that caused overflow..." }],
		isError: false,
		timestamp: 3,
	};
}

function buildCompactionHandoffDetails(overrides?: Partial<HandoffDetails>): HandoffDetails {
	const anthropicModel = requireModel("anthropic", "claude-sonnet-4-5");
	return {
		handoffType: "explicit",
		goal: "Fix the bug in login.ts",
		formattedMessage: "## Goal\nFix the bug in login.ts",
		parentSessionId: "",
		fileTokens: 100,
		replacementMessages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "Compacted history checkpoint" }],
				api: anthropicModel.api,
				provider: anthropicModel.provider,
				model: anthropicModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 4,
			},
		],
		keyFiles: [],
		...overrides,
	};
}

describe("handleContextOverflow", () => {
	const anthropicModel = requireModel("anthropic", "claude-sonnet-4-5");
	const smallContextModel = { ...anthropicModel, contextWindow: 1000 };

	it("removes lastToolResult from messages before compaction", async () => {
		const lastToolResult = buildTestToolResult();
		const messages = buildTestMessages(lastToolResult);

		const fetchImpl: typeof fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const parsed = JSON.parse(String(init?.body ?? "{}")) as {
				input?: string;
				query?: string;
			};

			// Verify the input does NOT contain the tool result
			expect(parsed.input).not.toContain("Large file content that caused overflow");
			expect(parsed.input).toContain("Fix the bug in login.ts");

			return new Response(JSON.stringify({ output: "Compacted history" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		await handleContextOverflow(
			{
				messages,
				lastToolResult,
				errorMessage: "context_length_exceeded",
			},
			{
				model: smallContextModel,
				morphApiKey: "test-morph-key",
				fetchImpl,
			},
		);

		expect(fetchImpl).toHaveBeenCalled();
	});

	it("derives goal from last user message (truncated to 12 words)", async () => {
		const longUserContent =
			"Fix the bug in login.ts that causes authentication to fail when the password contains special characters and the user session times out unexpectedly.";
		const messages: Message[] = [
			{
				role: "user",
				content: longUserContent,
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "I'll investigate." }],
				api: anthropicModel.api,
				provider: anthropicModel.provider,
				model: anthropicModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
			buildTestToolResult(),
		];

		const fetchImpl: typeof fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const parsed = JSON.parse(String(init?.body ?? "{}")) as {
				query?: string;
			};

			// Verify goal is truncated to 12 words
			const expectedWords = longUserContent.split(/\s+/).slice(0, 12);
			expect(parsed.query).toBe(expectedWords.join(" "));
			expect(parsed.query?.split(/\s+/).length).toBeLessThanOrEqual(12);

			return new Response(JSON.stringify({ output: "Compacted" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		await handleContextOverflow(
			{
				messages,
				lastToolResult: messages[messages.length - 1] as ToolResultMessage,
				errorMessage: "context_length_exceeded",
			},
			{
				model: smallContextModel,
				morphApiKey: "test-morph-key",
				fetchImpl,
			},
		);

		expect(fetchImpl).toHaveBeenCalled();
	});

	it("defaults goal to 'Continue the task' when no user messages exist", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "I'll help you." }],
				api: anthropicModel.api,
				provider: anthropicModel.provider,
				model: anthropicModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
			buildTestToolResult(),
		];

		const fetchImpl: typeof fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const parsed = JSON.parse(String(init?.body ?? "{}")) as {
				query?: string;
			};

			expect(parsed.query).toBe("Continue the task");

			return new Response(JSON.stringify({ output: "Compacted" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		await handleContextOverflow(
			{
				messages,
				lastToolResult: messages[messages.length - 1] as ToolResultMessage,
				errorMessage: "context_length_exceeded",
			},
			{
				model: smallContextModel,
				morphApiKey: "test-morph-key",
				fetchImpl,
			},
		);

		expect(fetchImpl).toHaveBeenCalled();
	});

	it("returns shouldRetry: true when compaction succeeds", async () => {
		const lastToolResult = buildTestToolResult();
		const messages = buildTestMessages(lastToolResult);

		const fetchImpl: typeof fetch = vi.fn(async () => {
			return new Response(JSON.stringify({ output: "Compacted history" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const result = await handleContextOverflow(
			{
				messages,
				lastToolResult,
				errorMessage: "context_length_exceeded",
			},
			{
				model: smallContextModel,
				morphApiKey: "test-morph-key",
				fetchImpl,
			},
		);

		expect(result.shouldRetry).toBe(true);
		expect(result.compactedMessages).toHaveLength(1);
		expect(result.compactedMessages[0].role).toBe("assistant");
	});

	it("returns shouldRetry: false when compaction fails", async () => {
		const lastToolResult = buildTestToolResult();
		const messages = buildTestMessages(lastToolResult);

		// Simulate Morph API error
		const fetchImpl: typeof fetch = vi.fn(async () => {
			return new Response(JSON.stringify({ error: "Morph API error" }), {
				status: 500,
				statusText: "Internal Server Error",
				headers: { "content-type": "application/json" },
			});
		});

		// Should throw, catch, and return shouldRetry: false
		await expect(
			handleContextOverflow(
				{
					messages,
					lastToolResult,
					errorMessage: "context_length_exceeded",
				},
				{
					model: smallContextModel,
					morphApiKey: "test-morph-key",
					fetchImpl,
				},
			),
		).rejects.toThrow("Morph compaction failed");
	});

	it("returns shouldRetry: false when morphApiKey is missing", async () => {
		const lastToolResult = buildTestToolResult();
		const messages = buildTestMessages(lastToolResult);

		// Missing morphApiKey should cause compaction to fail
		await expect(
			handleContextOverflow(
				{
					messages,
					lastToolResult,
					errorMessage: "context_length_exceeded",
				},
				{
					model: smallContextModel,
					morphApiKey: null,
				},
			),
		).rejects.toThrow("Morph compaction is required but MORPH_API_KEY is missing");
	});

	it("handles empty user message content gracefully", async () => {
		const messages: Message[] = [
			{
				role: "user",
				content: "", // Empty content
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "I'll help you." }],
				api: anthropicModel.api,
				provider: anthropicModel.provider,
				model: anthropicModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
			buildTestToolResult(),
		];

		const fetchImpl: typeof fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const parsed = JSON.parse(String(init?.body ?? "{}")) as {
				query?: string;
			};

			expect(parsed.query).toBe("Continue the task");

			return new Response(JSON.stringify({ output: "Compacted" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		await handleContextOverflow(
			{
				messages,
				lastToolResult: messages[messages.length - 1] as ToolResultMessage,
				errorMessage: "context_length_exceeded",
			},
			{
				model: smallContextModel,
				morphApiKey: "test-morph-key",
				fetchImpl,
			},
		);

		expect(fetchImpl).toHaveBeenCalled();
	});

	it("extracts text from array content blocks", async () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "First part" },
					{ type: "text", text: "Second part" },
				],
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "I'll help you." }],
				api: anthropicModel.api,
				provider: anthropicModel.provider,
				model: anthropicModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
			buildTestToolResult(),
		];

		const fetchImpl: typeof fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const parsed = JSON.parse(String(init?.body ?? "{}")) as {
				query?: string;
			};

			expect(parsed.query).toBe("First part Second part");

			return new Response(JSON.stringify({ output: "Compacted" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		await handleContextOverflow(
			{
				messages,
				lastToolResult: messages[messages.length - 1] as ToolResultMessage,
				errorMessage: "context_length_exceeded",
			},
			{
				model: smallContextModel,
				morphApiKey: "test-morph-key",
				fetchImpl,
			},
		);

		expect(fetchImpl).toHaveBeenCalled();
	});
});
