import { describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	stopReason: "end_turn" as string,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		middlewareStack = {
			add: () => undefined,
		};

		async send(): Promise<unknown> {
			return {
				$metadata: { httpStatusCode: 200, requestId: "request-id" },
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } };
					yield { messageStop: { stopReason: bedrockMock.stopReason } };
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
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";

const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

describe("Bedrock raw stop reasons", () => {
	it("preserves raw Bedrock stop reasons for successful stops", async () => {
		bedrockMock.stopReason = "end_turn";

		const message = await streamBedrock(model, context, { cacheRetention: "none" }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.rawStopReason).toBe("end_turn");
		expect(message.errorMessage).toBeUndefined();
	});

	it("preserves raw Bedrock stop reasons for provider error stops", async () => {
		bedrockMock.stopReason = "guardrail_intervened";

		const message = await streamBedrock(model, context, { cacheRetention: "none" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("guardrail_intervened");
		expect(message.errorMessage).toBe("Provider stopped with: guardrail_intervened");
	});
});
