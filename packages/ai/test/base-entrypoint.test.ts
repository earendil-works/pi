import { afterEach, describe, expect, it } from "vitest";
import { clearApiProviders, complete, getApiProvider, getApiProviders } from "../src/base.ts";
import { register as registerAmazonBedrock } from "../src/providers/amazon-bedrock.ts";
import { register as registerAnthropic } from "../src/providers/anthropic.ts";
import { register as registerAzureOpenAIResponses } from "../src/providers/azure-openai-responses.ts";
import { fauxAssistantMessage, registerFauxProvider } from "../src/providers/faux.ts";
import { register as registerGoogle } from "../src/providers/google.ts";
import { register as registerGoogleVertex } from "../src/providers/google-vertex.ts";
import { register as registerMistral } from "../src/providers/mistral.ts";
import { register as registerOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import { register as registerOpenAICompletions } from "../src/providers/openai-completions.ts";
import { register as registerOpenAIResponses } from "../src/providers/openai-responses.ts";

const registrations = [
	["bedrock-converse-stream", registerAmazonBedrock],
	["anthropic-messages", registerAnthropic],
	["azure-openai-responses", registerAzureOpenAIResponses],
	["google-generative-ai", registerGoogle],
	["google-vertex", registerGoogleVertex],
	["mistral-conversations", registerMistral],
	["openai-codex-responses", registerOpenAICodexResponses],
	["openai-completions", registerOpenAICompletions],
	["openai-responses", registerOpenAIResponses],
] as const;

afterEach(() => {
	clearApiProviders();
});

describe("base entrypoint", () => {
	it("starts without built-in provider registrations", () => {
		expect(getApiProviders()).toEqual([]);
	});

	it.each(registrations)("registers the %s transport explicitly", (api, register) => {
		register();
		expect(getApiProvider(api)?.api).toBe(api);
	});

	it("dispatches custom providers", async () => {
		const registration = registerFauxProvider();
		registration.setResponses([fauxAssistantMessage("hello")]);
		const response = await complete(registration.getModel(), {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		});
		expect(response.content).toEqual([{ type: "text", text: "hello" }]);
	});

	it("fails clearly when no transport is registered", async () => {
		await expect(
			complete(
				{
					id: "missing-model",
					name: "Missing Model",
					api: "missing-api",
					provider: "missing-provider",
					baseUrl: "https://example.com",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1,
					maxTokens: 1,
				},
				{ messages: [] },
			),
		).rejects.toThrow("No API provider registered for api: missing-api");
	});
});
