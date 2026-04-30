import { describe, expect, it } from "vitest";
import { getEnvApiKey } from "../src/env-api-keys.js";
import { getModels, getProviders } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { Api, KnownProvider, Model, ProviderStreamOptions } from "../src/types.js";
import { resolveApiKey } from "./oauth.js";

const githubCopilotToken = await resolveApiKey("github-copilot");

interface AnthropicLongCacheRetentionE2ECase {
	name: string;
	provider: KnownProvider;
	model: Model<"anthropic-messages">;
	apiKey: string | undefined;
}

function getE2EApiKey(provider: KnownProvider): string | undefined {
	if (provider === "github-copilot") {
		return githubCopilotToken;
	}
	return getEnvApiKey(provider);
}

function getAnthropicMessagesModels(provider: KnownProvider): Model<"anthropic-messages">[] {
	const models = getModels(provider) as Model<Api>[];
	return models.filter((model) => model.api === "anthropic-messages") as Model<"anthropic-messages">[];
}

const anthropicMessagesCases: AnthropicLongCacheRetentionE2ECase[] = getProviders().flatMap((provider) =>
	getAnthropicMessagesModels(provider).map((model) => ({
		name: `${provider}/${model.id}`,
		provider,
		model,
		apiKey: getE2EApiKey(provider),
	})),
);

function getProbePriority(model: Model<"anthropic-messages">): number {
	const modelId = model.id.toLowerCase();
	const cost = model.cost.input + model.cost.output;
	let priority = cost;

	if (modelId.includes("haiku") && (modelId.includes("4-5") || modelId.includes("4.5"))) {
		priority -= 1000;
	} else if (modelId.includes("sonnet") && (modelId.includes("4-") || modelId.includes("4."))) {
		priority -= 750;
	} else if (modelId.includes("claude") && (modelId.includes("4-") || modelId.includes("4."))) {
		priority -= 500;
	}

	return priority;
}

function selectOneCasePerProvider(cases: AnthropicLongCacheRetentionE2ECase[]): AnthropicLongCacheRetentionE2ECase[] {
	const byProvider = new Map<KnownProvider, AnthropicLongCacheRetentionE2ECase[]>();
	for (const testCase of cases) {
		const providerCases = byProvider.get(testCase.provider) ?? [];
		providerCases.push(testCase);
		byProvider.set(testCase.provider, providerCases);
	}

	return Array.from(byProvider.values()).map(
		(providerCases) =>
			providerCases.sort(
				(a, b) => getProbePriority(a.model) - getProbePriority(b.model) || a.model.id.localeCompare(b.model.id),
			)[0],
	);
}

const probeCases = selectOneCasePerProvider(anthropicMessagesCases);

function withLongCacheRetention(model: Model<"anthropic-messages">): Model<"anthropic-messages"> {
	return {
		...model,
		compat: {
			...model.compat,
			supportsLongCacheRetention: true,
		},
	};
}

async function expectLongCacheRetentionAccepted(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
): Promise<void> {
	const options: ProviderStreamOptions = {
		apiKey,
		cacheRetention: "long",
		maxTokens: 128,
		thinkingEnabled: false,
	};
	const response = await complete(
		model,
		{
			systemPrompt: "You are a concise assistant.",
			messages: [
				{
					role: "user",
					content: "Reply with exactly: long cache retention accepted",
					timestamp: Date.now(),
				},
			],
		},
		options,
	);

	expect(response.errorMessage, response.errorMessage).toBeFalsy();
	expect(response.stopReason, response.errorMessage).not.toBe("error");
}

describe("Anthropic Messages long cache retention E2E", () => {
	it("covers every generated anthropic-messages model", () => {
		const expectedModels = getProviders().flatMap((provider) =>
			getAnthropicMessagesModels(provider).map((model) => `${provider}/${model.id}`),
		);
		expect(anthropicMessagesCases.map((testCase) => testCase.name).sort()).toEqual(expectedModels.sort());
	});

	describe("forced long cache retention probe", () => {
		for (const testCase of probeCases) {
			const model = withLongCacheRetention(testCase.model);

			it.skipIf(!testCase.apiKey)(`${testCase.name} accepts long cache retention`, { retry: 2 }, async () => {
				await expectLongCacheRetentionAccepted(model, testCase.apiKey);
			});
		}
	});
});
