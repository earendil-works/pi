import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Model, OpenAICompletionsCompat } from "../src/types.ts";

const compat: Omit<Required<OpenAICompletionsCompat>, "deferredToolsMode"> & {
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
} = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
};

function imageModel(): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
	return { ...baseModel, api: "openai-completions", input: ["text", "image"] };
}

function firstImageUrl(context: Context): string {
	const messages = convertMessages(imageModel(), context, compat);
	const userMessage = messages.find((m) => m.role === "user" && Array.isArray(m.content));
	const parts = (userMessage?.content ?? []) as Array<{ type?: string; image_url?: { url?: string } }>;
	const image = parts.find((part) => part?.type === "image_url");
	if (!image?.image_url?.url) throw new Error("no image_url part found");
	return image.image_url.url;
}

describe("openai-completions image_url passthrough (earendil-works/pi#6151)", () => {
	it("passes a direct image url through without base64 conversion", () => {
		const now = Date.now();
		const url = firstImageUrl({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe this" },
						{ type: "image", url: "https://example.com/cat.png" },
					],
					timestamp: now,
				},
			],
		});
		expect(url).toBe("https://example.com/cat.png");
	});

	it("still wraps base64 data in a data URI when no url is provided", () => {
		const now = Date.now();
		const url = firstImageUrl({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe this" },
						{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
					],
					timestamp: now,
				},
			],
		});
		expect(url).toBe("data:image/png;base64,ZmFrZQ==");
	});

	it("prefers url over data when both are present", () => {
		const now = Date.now();
		const url = firstImageUrl({
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							url: "https://example.com/dog.jpg",
							data: "ZmFrZQ==",
							mimeType: "image/png",
						},
					],
					timestamp: now,
				},
			],
		});
		expect(url).toBe("https://example.com/dog.jpg");
	});
});
