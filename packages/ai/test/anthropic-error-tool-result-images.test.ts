import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

interface AnthropicPayload {
	messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 1024,
};

const assistant: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "toolCall", id: "call-1", name: "codemode", arguments: {} },
		{ type: "toolCall", id: "call-2", name: "read", arguments: {} },
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: Date.now(),
};

async function capturePayload(context: Context): Promise<AnthropicPayload> {
	let capturedPayload: AnthropicPayload | undefined;
	const stream = streamSimple(model, context, {
		apiKey: "fake-key",
		cacheRetention: "none",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!capturedPayload) throw new Error("Expected payload capture before request");
	return capturedPayload;
}

const image = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

describe("Anthropic error tool results with images", () => {
	// Regression for #10794: Anthropic rejects error tool results that contain images.
	it("moves the images after the tool results of the turn", async () => {
		const payload = await capturePayload({
			messages: [
				{ role: "user", content: "Show the screenshots", timestamp: Date.now() },
				assistant,
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "codemode",
					content: [
						{ type: "text", text: "Script failed" },
						{ type: "image", data: "AAAA", mimeType: "image/png" },
						{ type: "image", data: "CCCC", mimeType: "image/png" },
						{ type: "text", text: "Script error" },
					],
					isError: true,
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "call-2",
					toolName: "read",
					content: [{ type: "image", data: "BBBB", mimeType: "image/png" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		});

		expect(payload.messages[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "call-1",
					content: "Script failed\n(image attached after the tool results)\nScript error",
					is_error: true,
				},
				{
					type: "tool_result",
					tool_use_id: "call-2",
					content: [{ type: "text", text: "(see attached image)" }, image("BBBB")],
					is_error: false,
				},
				{ type: "text", text: "Images from the error result of tool call call-1 (codemode):" },
				image("AAAA"),
				image("CCCC"),
			],
		});
	});

	it("keeps error tool results without images unchanged", async () => {
		const payload = await capturePayload({
			messages: [
				{ role: "user", content: "Run it", timestamp: Date.now() },
				{ ...assistant, content: [assistant.content[0]] },
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "codemode",
					content: [{ type: "text", text: "Script failed" }],
					isError: true,
					timestamp: Date.now(),
				},
			],
		});

		expect(payload.messages[2]).toEqual({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "call-1", content: "Script failed", is_error: true }],
		});
	});
});
