import { beforeEach, describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	send: undefined as { kind: "resolve"; response: unknown } | undefined,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeClient {
		middlewareStack = { add: () => {} };

		send(): Promise<unknown> {
			const outcome = bedrockMock.send;
			if (!outcome) return Promise.reject(new Error("test did not configure a send outcome"));
			return Promise.resolve(outcome.response);
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
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function respondWithUsage(usage: Record<string, number>): void {
	bedrockMock.send = {
		kind: "resolve",
		response: {
			$metadata: { httpStatusCode: 200, requestId: "req" },
			stream: (async function* () {
				yield { messageStart: { role: "assistant" } };
				yield {
					contentBlockDelta: { contentBlockIndex: 0, delta: { text: "OK" } },
				};
				yield {
					messageStop: { stopReason: "end_turn" },
				};
				yield { metadata: { usage } };
			})(),
		},
	};
}

async function runBedrock(model: Model<"bedrock-converse-stream">): Promise<AssistantMessage> {
	return streamBedrock(model, context, { cacheRetention: "none" }).result();
}

beforeEach(() => {
	bedrockMock.send = undefined;
});

describe("bedrock-converse usage.input normalization", () => {
	it("keeps Anthropic inputTokens net of cache as reported", async () => {
		respondWithUsage({
			inputTokens: 2,
			outputTokens: 10,
			cacheReadInputTokens: 13923,
			cacheWriteInputTokens: 7262,
		});

		const message = await runBedrock(getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8"));

		expect(message.usage.input).toBe(2);
		expect(message.usage.cacheRead).toBe(13923);
		expect(message.usage.cacheWrite).toBe(7262);
		expect(message.usage.output).toBe(10);
	});

	it("subtracts cache tokens from gross input on OpenAI-family models", async () => {
		respondWithUsage({
			inputTokens: 12401,
			outputTokens: 10,
			cacheReadInputTokens: 8367,
			cacheWriteInputTokens: 4032,
		});

		const message = await runBedrock(getModel("amazon-bedrock", "us.deepseek.r1-v1:0"));

		// Gross input 12401 includes cacheRead 8367 + cacheWrite 4032 = 12399.
		expect(message.usage.input).toBe(2);
		expect(message.usage.cacheRead).toBe(8367);
		expect(message.usage.cacheWrite).toBe(4032);
	});

	it("leaves cache-less usage untouched on non-Anthropic models", async () => {
		respondWithUsage({ inputTokens: 500, outputTokens: 10 });

		const message = await runBedrock(getModel("amazon-bedrock", "us.deepseek.r1-v1:0"));

		expect(message.usage.input).toBe(500);
		expect(message.usage.cacheRead).toBe(0);
		expect(message.usage.cacheWrite).toBe(0);
	});

	it("floors at zero when cache tokens exceed the reported input", async () => {
		respondWithUsage({
			inputTokens: 100,
			outputTokens: 10,
			cacheReadInputTokens: 90,
			cacheWriteInputTokens: 50,
		});

		const message = await runBedrock(getModel("amazon-bedrock", "us.deepseek.r1-v1:0"));

		expect(message.usage.input).toBe(0);
	});
});
