import { describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	createParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			})}\n`,
			`event: content_block_start\ndata: ${JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "ok" },
			})}\n`,
			`event: content_block_delta\ndata: ${JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "ok" },
			})}\n`,
			`event: content_block_stop\ndata: ${JSON.stringify({
				type: "content_block_stop",
				index: 0,
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			})}\n`,
		].join("\n");

		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	class FakeAnthropic {
		messages = {
			create: (params: Record<string, unknown>) => {
				mockState.createParams = params;
				return {
					asResponse: async () => createSseResponse(),
				};
			},
		};
	}

	return { default: FakeAnthropic };
});

describe("kimi-coding thinking signature encoding", () => {
	const model = {
		id: "kimi-for-coding",
		name: "Kimi For Coding",
		api: "anthropic-messages",
		provider: "kimi-coding",
		baseUrl: "https://api.kimi.com/coding",
		reasoning: true,
		input: ["text"],
		output: ["text"],
		contextWindow: 200000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			supportsEagerToolInputStreaming: true,
			supportsLongCacheRetention: false,
			supportsCacheControlOnTools: true,
			supportsTemperature: true,
			allowEmptySignature: false,
			supportsStrictTools: false,
			supportsToolReferences: false,
		},
	} as Model<"anthropic-messages">;

	it("converts thinking signatures from base64 to base64url on replay", async () => {
		const base64Signature = "F31Ns+5lg+HZ/B2HKQwlNw==";
		const base64UrlSignature = "F31Ns-5lg-HZ_B2HKQwlNw";

		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Do something" }],
					timestamp: 1,
				},
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "planning...",
							thinkingSignature: base64Signature,
						},
						{
							type: "toolCall",
							id: "tool_1",
							name: "bash",
							arguments: { command: "echo hi" },
						},
					],
					api: "anthropic-messages",
					provider: "kimi-coding",
					model: "kimi-for-coding",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "tool_1",
					toolName: "bash",
					content: [{ type: "text", text: "hi" }],
					isError: false,
					timestamp: 3,
				},
			],
		};

		const s = streamAnthropic(model, context, {
			apiKey: "kimi_api_key_test",
			thinkingEnabled: true,
			thinkingBudgetTokens: 1024,
		});
		for await (const event of s) {
			if (event.type === "error") break;
		}

		const params = mockState.createParams!;
		expect(params).toBeDefined();

		const messages = params.messages as Array<{ role: string; content: unknown }>;
		const assistantMessage = messages.find((m) => m.role === "assistant");
		expect(assistantMessage).toBeDefined();

		const content = assistantMessage!.content as Array<{ type: string; signature?: string; data?: string }>;
		const thinkingBlock = content.find((c) => c.type === "thinking");
		expect(thinkingBlock).toBeDefined();
		expect(thinkingBlock!.signature).toBe(base64UrlSignature);
	});

	it("converts redacted thinking signatures from base64 to base64url on replay", async () => {
		const base64Signature = "a+b/c==";
		const base64UrlSignature = "a-b_c";

		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: base64Signature,
							redacted: true,
						},
					],
					api: "anthropic-messages",
					provider: "kimi-coding",
					model: "kimi-for-coding",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
				{
					role: "user",
					content: [{ type: "text", text: "Next" }],
					timestamp: 2,
				},
			],
		};

		const s = streamAnthropic(model, context, {
			apiKey: "kimi_api_key_test",
			thinkingEnabled: true,
			thinkingBudgetTokens: 1024,
		});
		for await (const event of s) {
			if (event.type === "error") break;
		}

		const params = mockState.createParams!;
		const messages = params.messages as Array<{ role: string; content: unknown }>;
		const assistantMessage = messages.find((m) => m.role === "assistant");
		expect(assistantMessage).toBeDefined();

		const content = assistantMessage!.content as Array<{ type: string; signature?: string; data?: string }>;
		const redactedBlock = content.find((c) => c.type === "redacted_thinking");
		expect(redactedBlock).toBeDefined();
		expect(redactedBlock!.data).toBe(base64UrlSignature);
	});
});
