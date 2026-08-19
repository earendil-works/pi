import { arch, platform, release } from "node:os";
import { describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
	finishReason: "MALFORMED_FUNCTION_CALL",
	includeFunctionCall: false,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		constructor(config: Record<string, unknown>) {
			googleGenAiMock.constructorCalls.push(config);
		}

		models = {
			generateContentStream: async function* () {
				yield {
					responseId: "google-response-id",
					candidates: [
						{
							finishReason: googleGenAiMock.finishReason,
							...(googleGenAiMock.includeFunctionCall && {
								content: {
									parts: [
										{
											functionCall: {
												id: "call-1",
												name: "echo",
												args: { value: "truncated" },
											},
										},
									],
								},
							}),
						},
					],
					usageMetadata: {
						promptTokenCount: 1,
						candidatesTokenCount: 0,
						totalTokenCount: 1,
					},
				};
			},
		};
	}

	return {
		FinishReason: {
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
			BLOCKLIST: "BLOCKLIST",
			PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
			SPII: "SPII",
			SAFETY: "SAFETY",
			IMAGE_SAFETY: "IMAGE_SAFETY",
			IMAGE_PROHIBITED_CONTENT: "IMAGE_PROHIBITED_CONTENT",
			IMAGE_RECITATION: "IMAGE_RECITATION",
			IMAGE_OTHER: "IMAGE_OTHER",
			RECITATION: "RECITATION",
			FINISH_REASON_UNSPECIFIED: "FINISH_REASON_UNSPECIFIED",
			OTHER: "OTHER",
			LANGUAGE: "LANGUAGE",
			MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL",
			UNEXPECTED_TOOL_CALL: "UNEXPECTED_TOOL_CALL",
			NO_IMAGE: "NO_IMAGE",
		},
		FunctionCallingConfigMode: {
			AUTO: "AUTO",
			NONE: "NONE",
			ANY: "ANY",
			VALIDATED: "VALIDATED",
		},
		GoogleGenAI,
		ResourceScope: {
			COLLECTION: "COLLECTION",
		},
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { stream as streamGoogleGenerativeAi } from "../src/api/google-generative-ai.ts";
import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";

const PI_USER_AGENT = `pi (${platform()} ${release()}; ${arch()})`;

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

async function captureGoogleHeaders(headers?: Record<string, string>): Promise<Record<string, string>> {
	googleGenAiMock.constructorCalls.length = 0;
	googleGenAiMock.finishReason = "STOP";
	googleGenAiMock.includeFunctionCall = false;
	await streamGoogleGenerativeAi(getModel("google", "gemini-2.5-flash"), context, {
		apiKey: "test-api-key",
		headers,
	}).result();

	expect(googleGenAiMock.constructorCalls).toHaveLength(1);
	const httpOptions = googleGenAiMock.constructorCalls[0].httpOptions as { headers?: Record<string, string> };
	return httpOptions.headers ?? {};
}

describe("Google raw stop reasons", () => {
	it("preserves raw Gemini finish reasons for Google Generative AI errors", async () => {
		googleGenAiMock.finishReason = "MALFORMED_FUNCTION_CALL";
		googleGenAiMock.includeFunctionCall = false;

		const stream = streamGoogleGenerativeAi(getModel("google", "gemini-2.5-flash"), context, {
			apiKey: "test-api-key",
		});

		const message = await stream.result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("MALFORMED_FUNCTION_CALL");
		expect(message.errorMessage).toBe("Provider stopped with: MALFORMED_FUNCTION_CALL");
	});

	it("preserves raw Gemini finish reasons for Google Vertex errors", async () => {
		googleGenAiMock.finishReason = "SAFETY";
		googleGenAiMock.includeFunctionCall = false;

		const stream = streamGoogleVertex(getModel("google-vertex", "gemini-3-flash-preview"), context, {
			project: "test-project",
			location: "us-central1",
		});

		const message = await stream.result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("SAFETY");
		expect(message.errorMessage).toBe("Provider stopped with: SAFETY");
	});

	const adapters = [
		{
			name: "Google Generative AI",
			createStream: () =>
				streamGoogleGenerativeAi(getModel("google", "gemini-2.5-flash"), context, {
					apiKey: "test-api-key",
				}),
		},
		{
			name: "Google Vertex",
			createStream: () =>
				streamGoogleVertex(getModel("google-vertex", "gemini-3-flash-preview"), context, {
					project: "test-project",
					location: "us-central1",
				}),
		},
	];

	it.each(adapters)("preserves MAX_TOKENS with a tool call as length for $name", async ({ createStream }) => {
		googleGenAiMock.finishReason = "MAX_TOKENS";
		googleGenAiMock.includeFunctionCall = true;

		const message = await createStream().result();

		expect(message.stopReason).toBe("length");
		expect(message.rawStopReason).toBe("MAX_TOKENS");
		expect(message.content.some((block) => block.type === "toolCall")).toBe(true);
	});

	it.each(adapters)("maps STOP with a tool call to toolUse for $name", async ({ createStream }) => {
		googleGenAiMock.finishReason = "STOP";
		googleGenAiMock.includeFunctionCall = true;

		const message = await createStream().result();

		expect(message.stopReason).toBe("toolUse");
		expect(message.rawStopReason).toBe("STOP");
		expect(message.content.some((block) => block.type === "toolCall")).toBe(true);
	});
});

describe("Google Generative AI user agent", () => {
	it("uses pi's User-Agent by default", async () => {
		expect((await captureGoogleHeaders())["User-Agent"]).toBe(PI_USER_AGENT);
	});

	it("lets explicit headers override the default User-Agent", async () => {
		expect((await captureGoogleHeaders({ "User-Agent": "custom-agent" }))["User-Agent"]).toBe("custom-agent");
	});
});
