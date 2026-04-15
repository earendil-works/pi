import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				yield {
					responseId: "vertex-response-id",
					candidates: [
						{
							content: { parts: [{ text: "ok" }] },
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 1,
						candidatesTokenCount: 1,
						totalTokenCount: 2,
					},
				};
			},
		};

		constructor(config: Record<string, unknown>) {
			googleGenAiMock.constructorCalls.push(config);
		}
	}

	return {
		GoogleGenAI,
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { getModel } from "../src/models.js";
import { streamGoogleVertex } from "../src/providers/google-vertex.js";
import type { Context } from "../src/types.js";

const model = getModel("google-vertex", "gemini-3-flash-preview");
const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const originalGoogleCloudApiKey = process.env.GOOGLE_CLOUD_API_KEY;

beforeEach(() => {
	googleGenAiMock.constructorCalls.length = 0;
	delete process.env.GOOGLE_CLOUD_API_KEY;
});

afterEach(() => {
	if (originalGoogleCloudApiKey === undefined) {
		delete process.env.GOOGLE_CLOUD_API_KEY;
	} else {
		process.env.GOOGLE_CLOUD_API_KEY = originalGoogleCloudApiKey;
	}
});

describe("google-vertex api key resolution", () => {
	it("falls back to ADC when options.apiKey is a placeholder marker", async () => {
		const stream = streamGoogleVertex(model, context, {
			apiKey: "<authenticated>",
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
	});

	it("falls back to ADC when options.apiKey is the gcp-vertex-credentials marker", async () => {
		const stream = streamGoogleVertex(model, context, {
			apiKey: "gcp-vertex-credentials",
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
	});

	it("falls back to ADC when GOOGLE_CLOUD_API_KEY is a placeholder marker", async () => {
		process.env.GOOGLE_CLOUD_API_KEY = "<authenticated>";

		const stream = streamGoogleVertex(model, context, {
			project: "test-project",
			location: "us-central1",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			project: "test-project",
			location: "us-central1",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("apiKey");
	});

	it("still uses the API key client for real API keys", async () => {
		const stream = streamGoogleVertex(model, context, {
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
		});

		await stream.result();

		expect(googleGenAiMock.constructorCalls).toHaveLength(1);
		expect(googleGenAiMock.constructorCalls[0]).toMatchObject({
			vertexai: true,
			apiKey: "AIzaSyExampleRealisticLookingApiKey123456",
			apiVersion: "v1",
		});
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("project");
		expect(googleGenAiMock.constructorCalls[0]).not.toHaveProperty("location");
	});
});
