import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OpenAI models served through Bedrock Converse (e.g. `global.openai.gpt-5.6-terra`)
 * return encrypted reasoning as the opaque `redactedContent` member of
 * `reasoningContent`, not as `reasoningText`. The AWS SDK decodes the wire blob to
 * `Uint8Array`.
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ReasoningContentBlockDelta.html
 */
const bedrockMock = vi.hoisted(() => {
	const redactedBase64 = "cnNuXzVaVnJpZjRKMGJYSXFtV2RsZWRqN1FJRmVOaWtSUWJF";
	return {
		redactedBase64,
		redactedBytes: new Uint8Array(Buffer.from(redactedBase64, "base64")),
		streamEvents: undefined as unknown[] | undefined,
	};
});

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		send(): Promise<unknown> {
			if (bedrockMock.streamEvents) {
				const events = bedrockMock.streamEvents;
				return Promise.resolve({
					$metadata: { httpStatusCode: 200 },
					stream: (async function* () {
						yield* events;
					})(),
				});
			}
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import type { Context, Message, Model, ThinkingContent } from "../src/types.ts";

const gptModel: Model<"bedrock-converse-stream"> = {
	id: "global.openai.gpt-5.6-terra",
	name: "GPT-5.6 Terra (Global)",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.ap-northeast-1.amazonaws.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const emptyUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Mirrors the ConverseStream frames GPT-5.6 emits: encrypted reasoning, then text. */
function redactedReasoningEvents(): unknown[] {
	return [
		{ messageStart: { role: "assistant" } },
		{
			contentBlockDelta: {
				contentBlockIndex: 0,
				delta: { reasoningContent: { redactedContent: bedrockMock.redactedBytes } },
			},
		},
		{ contentBlockStop: { contentBlockIndex: 0 } },
		{ contentBlockDelta: { contentBlockIndex: 1, delta: { text: "done" } } },
		{ contentBlockStop: { contentBlockIndex: 1 } },
		{ messageStop: { stopReason: "end_turn" } },
	];
}

interface BedrockRequestPayload {
	messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
}

async function capturePayload(context: Context): Promise<BedrockRequestPayload> {
	let capturedPayload: BedrockRequestPayload | undefined;
	const s = streamBedrock(gptModel, context, {
		cacheRetention: "none",
		signal: AbortSignal.abort(),
		onPayload: (payload) => {
			capturedPayload = payload as BedrockRequestPayload;
			return payload;
		},
	});
	for await (const event of s) {
		if (event.type === "error") break;
	}
	if (!capturedPayload) {
		throw new Error("Expected Bedrock payload to be captured before request abort");
	}
	return capturedPayload;
}

describe("Bedrock redacted reasoning", () => {
	beforeEach(() => {
		bedrockMock.streamEvents = undefined;
	});

	it("does not fail the stream when reasoning arrives as redactedContent", async () => {
		bedrockMock.streamEvents = redactedReasoningEvents();

		const response = await streamBedrock(gptModel, {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		}).result();

		expect(response.stopReason, response.errorMessage).not.toBe("error");
		// Reasoning precedes the answer, matching the order Bedrock streamed it.
		expect(response.content.map((c) => c.type)).toEqual(["thinking", "text"]);
		expect(response.content[1]).toEqual({ type: "text", text: "done" });
	});

	it("preserves the encrypted reasoning payload on the assistant message", async () => {
		bedrockMock.streamEvents = redactedReasoningEvents();

		const response = await streamBedrock(gptModel, {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		}).result();

		const thinking = response.content.find((c): c is ThinkingContent => c.type === "thinking");
		expect(thinking).toBeDefined();
		// Same representation Anthropic redacted thinking already uses: the opaque
		// payload rides in `thinkingSignature` with `redacted: true`.
		expect(thinking?.redacted).toBe(true);
		expect(thinking?.thinkingSignature).toBe(bedrockMock.redactedBase64);
		// The byte buffer is streaming scratch state: persisting it would bloat the
		// session, since a Uint8Array serializes to an index-keyed object.
		expect("redactedChunks" in thinking!).toBe(false);
	});

	it("encodes the payload when the stream never sends contentBlockStop", async () => {
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { reasoningContent: { redactedContent: bedrockMock.redactedBytes } },
				},
			},
			{ messageStop: { stopReason: "end_turn" } },
		];

		const response = await streamBedrock(gptModel, {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		}).result();

		const thinking = response.content.find((c): c is ThinkingContent => c.type === "thinking");
		expect(thinking?.thinkingSignature).toBe(bedrockMock.redactedBase64);
		// Streaming scratch state must not survive into the persisted message.
		expect("redactedChunks" in thinking!).toBe(false);
		expect("index" in thinking!).toBe(false);
	});

	it("joins encrypted reasoning split across deltas", async () => {
		const [head, tail] = [bedrockMock.redactedBytes.slice(0, 7), bedrockMock.redactedBytes.slice(7)];
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: head } } } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: tail } } } },
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "end_turn" } },
		];

		const response = await streamBedrock(gptModel, {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		}).result();

		const thinking = response.content.find((c): c is ThinkingContent => c.type === "thinking");
		expect(thinking?.thinkingSignature).toBe(bedrockMock.redactedBase64);
		// The placeholder marks the block once, not once per delta.
		expect(thinking?.thinking).toBe("[Reasoning redacted]");
	});

	it("replays redacted reasoning as reasoningContent.redactedContent", async () => {
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: Date.now() },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "", thinkingSignature: bedrockMock.redactedBase64, redacted: true },
					{ type: "text", text: "done" },
				],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: gptModel.id,
				usage: emptyUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			},
			{ role: "user", content: "continue", timestamp: Date.now() },
		];

		const payload = await capturePayload({ messages });

		const assistant = payload.messages.find((m: any) => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant!.content).toEqual([
			{ reasoningContent: { redactedContent: bedrockMock.redactedBytes } },
			{ text: "done" },
		]);
	});

	it("replays redacted reasoning before the toolUse block it belongs to", async () => {
		// Bedrock rejects a tool continuation whose reasoning block is missing or
		// reordered, so the opaque payload must land ahead of the matching toolUse.
		const messages: Message[] = [
			{ role: "user", content: "read the file", timestamp: Date.now() },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "", thinkingSignature: bedrockMock.redactedBase64, redacted: true },
					{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "/tmp/a.txt" } },
				],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: gptModel.id,
				usage: emptyUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [{ type: "text", text: "file body" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const payload = await capturePayload({ messages });

		const assistant = payload.messages.find((m: any) => m.role === "assistant");
		expect(assistant).toBeDefined();
		expect(assistant!.content).toEqual([
			{ reasoningContent: { redactedContent: bedrockMock.redactedBytes } },
			{ toolUse: { toolUseId: "tool-1", name: "read", input: { path: "/tmp/a.txt" } } },
		]);
	});
});
