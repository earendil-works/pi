import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { AssistantMessage, Context, Usage } from "../src/types.js";

function makeUsage(): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeAnthropicSseStream(text = "OK"): Response {
	const encoder = new TextEncoder();
	const events = [
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-sonnet-4-5-20251001",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		})}\n\n`,
		`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
		`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
		`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
		`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
	];
	const stream = new ReadableStream({
		start(controller) {
			for (const e of events) controller.enqueue(encoder.encode(e));
			controller.close();
		},
	});
	return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("Anthropic unsigned thinking blocks", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("drops unsigned thinking block from outgoing API request (not sent as text)", async () => {
		let capturedBody: Record<string, unknown> | undefined;

		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return makeAnthropicSseStream();
		});

		const model = getModel("anthropic", "claude-sonnet-4-5");
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Let me reason through this step by step...",
					thinkingSignature: "", // no signature — aborted stream or compat provider
				},
				{
					type: "text",
					text: "The answer is 4.",
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: makeUsage(),
			stopReason: "stop",
			timestamp: Date.now() - 2000,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "What is 2+2?", timestamp: Date.now() - 3000 },
				assistantMessage,
				{ role: "user", content: "Explain your reasoning.", timestamp: Date.now() },
			],
		};

		const s = streamAnthropic(model, context, { apiKey: "test-key" });
		await s.result();

		expect(capturedBody).toBeDefined();

		type Block = { type: string; text?: string };
		type Msg = { role: string; content: Block[] };
		const outgoing = capturedBody as { messages: Msg[] };
		const assistantMsgs = outgoing.messages.filter((m) => m.role === "assistant");
		expect(assistantMsgs).toHaveLength(1);

		const content = assistantMsgs[0].content;

		// Unsigned thinking must not appear as a visible text block
		expect(content.find((b) => b.type === "text" && b.text?.includes("Let me reason"))).toBeUndefined();
		// Unsigned thinking must not appear as a thinking block either
		expect(content.find((b) => b.type === "thinking")).toBeUndefined();
		// The legitimate text block must still be present
		expect(content.find((b) => b.type === "text" && b.text === "The answer is 4.")).toBeDefined();
	});

	it("keeps signed thinking blocks in outgoing API request", async () => {
		let capturedBody: Record<string, unknown> | undefined;

		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedBody = JSON.parse(init?.body as string);
			return makeAnthropicSseStream();
		});

		const model = getModel("anthropic", "claude-sonnet-4-5");
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "I should calculate carefully.",
					thinkingSignature: "valid-opaque-signature-abc123",
				},
				{
					type: "text",
					text: "The answer is 42.",
				},
			],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: makeUsage(),
			stopReason: "stop",
			timestamp: Date.now() - 2000,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "What is 6*7?", timestamp: Date.now() - 3000 },
				assistantMessage,
				{ role: "user", content: "Are you sure?", timestamp: Date.now() },
			],
		};

		const s = streamAnthropic(model, context, { apiKey: "test-key" });
		await s.result();

		expect(capturedBody).toBeDefined();

		type Block = { type: string; text?: string; thinking?: string; signature?: string };
		type Msg = { role: string; content: Block[] };
		const outgoing = capturedBody as { messages: Msg[] };
		const assistantMsgs = outgoing.messages.filter((m) => m.role === "assistant");
		expect(assistantMsgs).toHaveLength(1);

		const content = assistantMsgs[0].content;

		// Signed thinking block must be replayed as a thinking block with its signature
		const thinkingBlock = content.find((b) => b.type === "thinking");
		expect(thinkingBlock).toBeDefined();
		expect(thinkingBlock?.thinking).toBe("I should calculate carefully.");
		expect(thinkingBlock?.signature).toBe("valid-opaque-signature-abc123");
	});
});
