import { describe, expect, it, vi } from "vitest";

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		middlewareStack = { add: () => undefined };

		async send(): Promise<unknown> {
			return {
				$metadata: { httpStatusCode: 200 },
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } };
					yield {
						metadata: {
							usage: {
								inputTokens: 100,
								outputTokens: 5,
								totalTokens: 1_000_105,
								cacheWriteInputTokens: 1_000_000,
								cacheDetails: [
									{ ttl: "1h", inputTokens: 150_000 },
									{ ttl: "5m", inputTokens: 600_000 },
									{ ttl: "1h", inputTokens: 250_000 },
								],
							},
						},
					};
					yield { messageStop: { stopReason: "end_turn" } };
				})(),
			};
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
		CacheTTL: { FIVE_MINUTES: "5m", ONE_HOUR: "1h" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";

const model = {
	...getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8"),
	// Keep this pricing-math regression independent of live catalog updates.
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

describe("Bedrock 1h cache write cost", () => {
	it("prices the 1h cache details at 2x while preserving the total cache write", async () => {
		// Regression test for https://github.com/earendil-works/pi/issues/9457
		const result = await streamBedrock(model, context, { cacheRetention: "none" }).result();

		expect(result.usage.cacheWrite).toBe(1_000_000);
		expect(result.usage.cacheWrite1h).toBe(400_000);
		// 600k * 6.25/Mtok + 400k * 10/Mtok = 3.75 + 4.0 = 7.75
		expect(result.usage.cost.cacheWrite).toBeCloseTo(7.75, 10);
	});
});
