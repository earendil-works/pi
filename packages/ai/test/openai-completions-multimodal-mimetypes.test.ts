import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { convertMessages } from "../src/providers/openai-completions.js";
import type { Context, Model, OpenAICompletionsCompat } from "../src/types.js";

const compat: Required<OpenAICompletionsCompat> = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	reasoningEffortMap: {},
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	supportsStrictMode: true,
};

function buildMultimodalModel(input: ("text" | "image" | "video" | "audio")[]): Model<"openai-completions"> {
	const base = getModel("openai", "gpt-4o-mini");
	return {
		...base,
		api: "openai-completions",
		input,
	};
}

describe("openai-completions content-part mapping by mimeType", () => {
	const now = Date.now();

	it("maps video/* mimeTypes to video_url content parts", () => {
		const model = buildMultimodalModel(["text", "video"]);
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "What happens in this clip?" },
						{ type: "image", data: "ZmFrZQ==", mimeType: "video/mp4" },
					],
					timestamp: now,
				},
			],
		};

		const params = convertMessages(model, context, compat);
		const userMsg = params.find((p) => p.role === "user");
		expect(userMsg).toBeDefined();
		const parts = userMsg!.content as any[];
		expect(parts.some((p) => p.type === "video_url")).toBe(true);
		const videoPart = parts.find((p) => p.type === "video_url");
		expect(videoPart.video_url.url).toBe("data:video/mp4;base64,ZmFrZQ==");
	});

	it("maps audio/* mimeTypes to audio_url content parts", () => {
		const model = buildMultimodalModel(["text", "audio"]);
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Transcribe this." },
						{ type: "image", data: "ZmFrZQ==", mimeType: "audio/wav" },
					],
					timestamp: now,
				},
			],
		};

		const params = convertMessages(model, context, compat);
		const userMsg = params.find((p) => p.role === "user");
		const parts = userMsg!.content as any[];
		expect(parts.some((p) => p.type === "audio_url")).toBe(true);
		const audioPart = parts.find((p) => p.type === "audio_url");
		expect(audioPart.audio_url.url).toBe("data:audio/wav;base64,ZmFrZQ==");
	});

	it("still maps image/* mimeTypes to image_url content parts", () => {
		const model = buildMultimodalModel(["text", "image"]);
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Describe." },
						{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
					],
					timestamp: now,
				},
			],
		};

		const params = convertMessages(model, context, compat);
		const userMsg = params.find((p) => p.role === "user");
		const parts = userMsg!.content as any[];
		expect(parts.some((p) => p.type === "image_url")).toBe(true);
	});

	it("filters out video_url when model does not declare video capability", () => {
		const model = buildMultimodalModel(["text"]);
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Hello" },
						{ type: "image", data: "ZmFrZQ==", mimeType: "video/mp4" },
					],
					timestamp: now,
				},
			],
		};

		const params = convertMessages(model, context, compat);
		const userMsg = params.find((p) => p.role === "user");
		const parts = userMsg!.content as any[];
		expect(parts.some((p) => p.type === "video_url")).toBe(false);
		expect(parts.some((p) => p.type === "text")).toBe(true);
	});

	it("filters out audio_url when model does not declare audio capability", () => {
		const model = buildMultimodalModel(["text", "image"]);
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Hello" },
						{ type: "image", data: "ZmFrZQ==", mimeType: "audio/wav" },
					],
					timestamp: now,
				},
			],
		};

		const params = convertMessages(model, context, compat);
		const userMsg = params.find((p) => p.role === "user");
		const parts = userMsg!.content as any[];
		expect(parts.some((p) => p.type === "audio_url")).toBe(false);
	});

	it("mixed media: passes through only declared capabilities", () => {
		const model = buildMultimodalModel(["text", "image", "video", "audio"]);
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "All three" },
						{ type: "image", data: "aW1n", mimeType: "image/png" },
						{ type: "image", data: "dmlk", mimeType: "video/webm" },
						{ type: "image", data: "YXVk", mimeType: "audio/mpeg" },
					],
					timestamp: now,
				},
			],
		};

		const params = convertMessages(model, context, compat);
		const userMsg = params.find((p) => p.role === "user");
		const parts = userMsg!.content as any[];
		expect(parts.filter((p) => p.type === "image_url")).toHaveLength(1);
		expect(parts.filter((p) => p.type === "video_url")).toHaveLength(1);
		expect(parts.filter((p) => p.type === "audio_url")).toHaveLength(1);
	});
});
