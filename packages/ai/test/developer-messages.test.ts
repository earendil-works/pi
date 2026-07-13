import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropicMessages } from "../src/api/anthropic-messages.ts";
import {
	downgradeDeveloperMessages,
	SYNTHETIC_DEVELOPER_MESSAGE_PREFIX,
	SYNTHETIC_DEVELOPER_MESSAGE_SUFFIX,
} from "../src/api/developer-messages.ts";
import { convertMessages as convertGoogleMessages } from "../src/api/google-shared.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { Context, DeveloperMessage, Model } from "../src/types.ts";

const developerMessage: DeveloperMessage = {
	role: "developer",
	content: "Use concise answers.",
	timestamp: 1,
};

const openAICompletionsModel: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
	compat: { supportsDeveloperRole: true },
};

function contextWithDeveloperMessage(): Context {
	return { messages: [developerMessage] };
}

async function captureOpenAICompletionsMessages(
	model: Model<"openai-completions">,
): Promise<Array<{ role: string; content: unknown }>> {
	let messages: Array<{ role: string; content: unknown }> | undefined;
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		}),
	);

	const stream = streamOpenAICompletions(model, contextWithDeveloperMessage(), {
		apiKey: "test-key",
		cacheRetention: "none",
		onPayload: (payload) => {
			messages = (payload as { messages: Array<{ role: string; content: unknown }> }).messages;
		},
	});
	await stream.result();
	if (!messages) throw new Error("Expected OpenAI payload to be captured");
	return messages;
}

async function captureAnthropicMessages(
	model: Model<"anthropic-messages">,
	context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }, developerMessage] },
): Promise<Array<{ role: string; content: unknown }>> {
	let messages: Array<{ role: string; content: unknown }> | undefined;
	const stream = streamAnthropicMessages({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
		apiKey: "test-key",
		cacheRetention: "none",
		onPayload: (payload) => {
			messages = (payload as { messages: Array<{ role: string; content: unknown }> }).messages;
		},
	});
	await stream.result();
	if (!messages) throw new Error("Expected Anthropic payload to be captured before request failure");
	return messages;
}

describe("developer messages", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("maps to developer in OpenAI Responses", () => {
		const input = convertResponsesMessages(
			getModel("openai", "gpt-5.4"),
			contextWithDeveloperMessage(),
			new Set(["openai"]),
		);

		expect(input).toEqual([{ role: "developer", content: "Use concise answers." }]);
	});

	it("falls back to a marked user message for OpenAI Responses models without developer-role support", () => {
		const model: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			compat: { supportsDeveloperRole: false },
		};
		const input = convertResponsesMessages(model, contextWithDeveloperMessage(), new Set(["openai"]));

		expect(input).toHaveLength(1);
		expect(input[0]).toMatchObject({ role: "user" });
		expect(input[0]).toMatchObject({
			content: [{ type: "input_text", text: expect.stringContaining("<developer_message>") }],
		});
	});

	it("maps to developer in OpenAI Chat Completions", async () => {
		const messages = await captureOpenAICompletionsMessages(openAICompletionsModel);
		expect(messages).toEqual([{ role: "developer", content: "Use concise answers." }]);
	});

	it("falls back to a marked user message in OpenAI Chat Completions", async () => {
		const messages = await captureOpenAICompletionsMessages({
			...openAICompletionsModel,
			compat: { supportsDeveloperRole: false },
		});
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");
		expect(messages[0].content).toContain("<developer_message>");
	});

	it("defaults unverified OpenAI-compatible providers to marked user messages", async () => {
		const messages = await captureOpenAICompletionsMessages(getModel("groq", "llama-3.1-8b-instant"));
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");
		expect(messages[0].content).toContain("<developer_message>");
	});

	it("uses developer messages only for verified OpenRouter models", async () => {
		const verified = await captureOpenAICompletionsMessages(getModel("openrouter", "openai/gpt-oss-20b"));
		expect(verified).toEqual([{ role: "developer", content: "Use concise answers." }]);

		const unverified = await captureOpenAICompletionsMessages(getModel("openrouter", "anthropic/claude-opus-4.8"));
		expect(unverified).toHaveLength(1);
		expect(unverified[0].role).toBe("user");
		expect(unverified[0].content).toContain("<developer_message>");
	});

	it("defaults unverified Responses models to marked user messages", () => {
		const model = getModel("openai-codex", "gpt-5.6-luna");
		const input = convertResponsesMessages(model, contextWithDeveloperMessage(), new Set(["openai-codex"]));
		expect(input).toHaveLength(1);
		expect(input[0]).toMatchObject({ role: "user" });
	});

	it("uses native system messages for supported Anthropic models", async () => {
		const messages = await captureAnthropicMessages(getModel("anthropic", "claude-opus-4-8"));
		expect(messages).toEqual([
			{ role: "user", content: "Hello" },
			{ role: "system", content: "Use concise answers." },
		]);
	});

	it("degrades developer messages for unsupported Anthropic models", async () => {
		const messages = await captureAnthropicMessages(getModel("anthropic", "claude-opus-4-7"));
		expect(messages).toHaveLength(2);
		expect(messages[1].role).toBe("user");
		expect(messages[1].content).toContain("<developer_message>");
	});

	it("degrades developer messages with invalid Anthropic placement", async () => {
		const messages = await captureAnthropicMessages(
			getModel("anthropic", "claude-opus-4-8"),
			contextWithDeveloperMessage(),
		);
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");
		expect(messages[0].content).toContain("<developer_message>");
	});

	it("degrades to a marked user message", () => {
		expect(downgradeDeveloperMessages([developerMessage])).toEqual([
			{
				role: "user",
				content: `${SYNTHETIC_DEVELOPER_MESSAGE_PREFIX}Use concise answers.${SYNTHETIC_DEVELOPER_MESSAGE_SUFFIX}`,
				timestamp: 1,
			},
		]);
	});

	it("degrades to a marked user message for Gemini", () => {
		const messages = convertGoogleMessages(getModel("google", "gemini-2.5-flash"), contextWithDeveloperMessage());
		expect(messages).toEqual([
			{
				role: "user",
				parts: [
					{
						text: `${SYNTHETIC_DEVELOPER_MESSAGE_PREFIX}Use concise answers.${SYNTHETIC_DEVELOPER_MESSAGE_SUFFIX}`,
					},
				],
			},
		]);
	});

	it.each(["claude-opus-4-8", "claude-fable-5", "claude-sonnet-5"] as const)(
		"marks Anthropic %s as supporting native developer messages",
		(modelId) => {
			expect(getModel("anthropic", modelId).compat?.supportsDeveloperRole).toBe(true);
		},
	);

	it.each(["claude-opus-4-7", "claude-sonnet-4-6"] as const)(
		"does not mark Anthropic %s as supporting native developer messages",
		(modelId) => {
			expect(getModel("anthropic", modelId).compat?.supportsDeveloperRole).not.toBe(true);
		},
	);
});
