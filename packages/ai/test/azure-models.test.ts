import { describe, expect, it } from "vitest";
import type { ChatModel, ProviderContext } from "../catalog/define.ts";
import azure from "../catalog/providers/azure.ts";

const openAiModel: ChatModel = {
	id: "gpt-6-sol",
	name: "GPT-6 Sol",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: {
		input: 2,
		output: 10,
		cacheRead: 0.2,
		cacheWrite: 2.5,
		tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
	},
	contextWindow: 272000,
	maxTokens: 128000,
};

function context(): ProviderContext {
	return {
		providerId: "azure",
		sources: {} as ProviderContext["sources"],
		strict: false,
		providerModels: (providerId) => (providerId === "openai" ? [structuredClone(openAiModel)] : []),
		modelsDevSource: () => undefined,
		recordModelsDevSource: () => {},
	};
}

describe("Azure catalog", () => {
	it("keeps OpenAI's long-context price tier on Azure OpenAI models", () => {
		const model = azure.models?.(context()).find((candidate) => candidate.id === "gpt-6-sol");
		expect(model?.provider).toBe("azure");
		expect(model?.api).toBe("azure-openai-responses");
		expect(model?.contextWindow).toBe(1050000);
		expect(model?.cost).toEqual(openAiModel.cost);
	});
});
