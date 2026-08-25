import { describe, expect, it, vi } from "vitest";

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		send(): Promise<unknown> {
			return Promise.resolve({
				$metadata: { httpStatusCode: 200 },
				stream: (async function* () {})(),
			});
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
import type { AssistantMessage, Context, Model, ToolResultMessage, Usage } from "../src/types.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const openaiModel: Model<"bedrock-converse-stream"> = {
	id: "us.openai.gpt-5.6-sol",
	name: "GPT-5.6 Sol (US)",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
	compat: undefined,
};

const anthropicModel: Model<"bedrock-converse-stream"> = {
	...openaiModel,
	id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
	name: "Claude Sonnet 4.5 (US)",
};

const PNG_DATA = "iVBORw0KGgo=";

function buildAssistantToolCalls(toolCallIds: string[], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: toolCallIds.map((id) => ({
			type: "toolCall",
			id,
			name: "read",
			arguments: { path: "/tmp/chart.png" },
		})),
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		model: openaiModel.id,
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp,
	};
}

function buildImageToolResult(toolCallId: string, timestamp: number, text?: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [
			...(text !== undefined ? [{ type: "text" as const, text }] : []),
			{ type: "image" as const, data: PNG_DATA, mimeType: "image/png" },
		],
		isError: false,
		timestamp,
	};
}

async function capturePayload(context: Context, model: Model<"bedrock-converse-stream">): Promise<unknown> {
	let capturedPayload: unknown;
	const s = streamBedrock(model, context, {
		cacheRetention: "none",
		signal: AbortSignal.abort(),
		onPayload: (payload) => {
			capturedPayload = payload;
			return payload;
		},
	});
	for await (const event of s) {
		if (event.type === "error") break;
	}
	return capturedPayload;
}

type BedrockMessage = {
	role: string;
	content: Array<{
		text?: string;
		image?: { format: string; source: { bytes: Uint8Array } };
		toolResult?: { toolUseId: string; content: Array<{ text?: string; image?: unknown }> };
	}>;
};

function buildContext(toolCallIds: string[], resultText?: string): Context {
	const messages: Context["messages"] = [
		{ role: "user", content: "Read the chart", timestamp: 1 },
		buildAssistantToolCalls(toolCallIds, 2),
	];
	for (const [index, id] of toolCallIds.entries()) {
		messages.push(buildImageToolResult(id, 3 + index, resultText));
	}
	return { messages };
}

describe("Bedrock tool result images", () => {
	it("hoists tool result images to sibling user content blocks for OpenAI models", async () => {
		const payload = await capturePayload(buildContext(["tool-1"], "rendered chart"), openaiModel);
		const messages = (payload as { messages: BedrockMessage[] }).messages;
		const toolResultMessage = messages[messages.length - 1];

		expect(toolResultMessage.role).toBe("user");
		expect(toolResultMessage.content).toHaveLength(2);
		expect(toolResultMessage.content[0].toolResult?.content).toEqual([{ text: "rendered chart" }]);
		expect(toolResultMessage.content[1].image?.format).toBe("png");
	});

	it("keeps a placeholder in image-only tool results for OpenAI models", async () => {
		const payload = await capturePayload(buildContext(["tool-1"]), openaiModel);
		const messages = (payload as { messages: BedrockMessage[] }).messages;
		const toolResultMessage = messages[messages.length - 1];

		expect(toolResultMessage.content[0].toolResult?.content).toEqual([{ text: "<empty>" }]);
		expect(toolResultMessage.content[1].image?.format).toBe("png");
	});

	it("hoists images from consecutive tool results into the same user message", async () => {
		const payload = await capturePayload(buildContext(["tool-1", "tool-2"], "ok"), openaiModel);
		const messages = (payload as { messages: BedrockMessage[] }).messages;
		const toolResultMessage = messages[messages.length - 1];

		expect(toolResultMessage.content.map((block) => Object.keys(block)[0])).toEqual([
			"toolResult",
			"toolResult",
			"image",
			"image",
		]);
	});

	it("keeps images nested in toolResult.content for non-OpenAI models", async () => {
		const payload = await capturePayload(buildContext(["tool-1"], "rendered chart"), anthropicModel);
		const messages = (payload as { messages: BedrockMessage[] }).messages;
		const toolResultMessage = messages[messages.length - 1];

		expect(toolResultMessage.content).toHaveLength(1);
		expect(toolResultMessage.content[0].toolResult?.content).toHaveLength(2);
		expect(toolResultMessage.content[0].toolResult?.content[1].image).toBeDefined();
	});
});
