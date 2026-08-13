import { describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	finishReason: "MALFORMED_FUNCTION_CALL",
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				yield {
					responseId: "google-response-id",
					candidates: [
						{
							finishReason: googleGenAiMock.finishReason,
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

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

describe("Google raw stop reasons", () => {
	it("preserves raw Gemini finish reasons for Google Generative AI errors", async () => {
		googleGenAiMock.finishReason = "MALFORMED_FUNCTION_CALL";

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

		const stream = streamGoogleVertex(getModel("google-vertex", "gemini-3-flash-preview"), context, {
			project: "test-project",
			location: "us-central1",
		});

		const message = await stream.result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("SAFETY");
		expect(message.errorMessage).toBe("Provider stopped with: SAFETY");
	});
});
