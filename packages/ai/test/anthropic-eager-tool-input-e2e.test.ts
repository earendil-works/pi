import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getEnvApiKey } from "../src/env-api-keys.js";
import { getModels, getProviders } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { Api, KnownProvider, Model, ProviderStreamOptions, Tool } from "../src/types.js";
import { resolveApiKey } from "./oauth.js";

const githubCopilotToken = await resolveApiKey("github-copilot");

const echoToolSchema = Type.Object({
	value: Type.String({ description: "The value to echo" }),
});

const echoTool: Tool<typeof echoToolSchema> = {
	name: "echo_value",
	description: "Echo a string value",
	parameters: echoToolSchema,
};

interface AnthropicEagerE2ECase {
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

const anthropicMessagesCases: AnthropicEagerE2ECase[] = getProviders().flatMap((provider) =>
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

	// Prefer current Claude 4 Haiku routes when present: they are cheap and avoid
	// stale Claude 3.x aliases that can remain in catalogs after upstream removal.
	if (modelId.includes("haiku") && (modelId.includes("4-5") || modelId.includes("4.5"))) {
		priority -= 1000;
	} else if (modelId.includes("sonnet") && (modelId.includes("4-") || modelId.includes("4."))) {
		priority -= 750;
	} else if (modelId.includes("claude") && (modelId.includes("4-") || modelId.includes("4."))) {
		priority -= 500;
	}

	return priority;
}

function selectOneCasePerProvider(cases: AnthropicEagerE2ECase[]): AnthropicEagerE2ECase[] {
	const byProvider = new Map<KnownProvider, AnthropicEagerE2ECase[]>();
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

const generatedCompatCases = selectOneCasePerProvider(anthropicMessagesCases);
const forcedEagerProbeCases = selectOneCasePerProvider(
	anthropicMessagesCases.filter((testCase) => testCase.model.compat?.supportsEagerToolInputStreaming !== false),
);

function withEagerToolInputStreaming(model: Model<"anthropic-messages">): Model<"anthropic-messages"> {
	return {
		...model,
		compat: {
			...model.compat,
			supportsEagerToolInputStreaming: true,
		},
	};
}

async function expectToolEnabledRequestAccepted(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
): Promise<void> {
	const options: ProviderStreamOptions = {
		apiKey,
		maxTokens: 128,
		thinkingEnabled: false,
	};
	const response = await complete(
		model,
		{
			systemPrompt: "You are a concise assistant. Use tools when useful.",
			messages: [
				{
					role: "user",
					content: "Call echo_value with value set to eager-input-streaming-compat.",
					timestamp: Date.now(),
				},
			],
			tools: [echoTool],
		},
		options,
	);

	expect(response.errorMessage, response.errorMessage).toBeFalsy();
	expect(response.stopReason, response.errorMessage).not.toBe("error");
}

describe("Anthropic Messages eager tool input streaming E2E", () => {
	it("covers every generated anthropic-messages model", () => {
		const expectedModels = getProviders().flatMap((provider) =>
			getAnthropicMessagesModels(provider).map((model) => `${provider}/${model.id}`),
		);
		expect(anthropicMessagesCases.map((testCase) => testCase.name).sort()).toEqual(expectedModels.sort());
	});

	describe("generated compatibility settings", () => {
		for (const testCase of generatedCompatCases) {
			it.skipIf(!testCase.apiKey)(`${testCase.name} accepts configured tool streaming`, { retry: 2 }, async () => {
				await expectToolEnabledRequestAccepted(testCase.model, testCase.apiKey);
			});
		}
	});

	describe("forced eager_input_streaming probe", () => {
		for (const testCase of forcedEagerProbeCases) {
			const model = withEagerToolInputStreaming(testCase.model);

			it.skipIf(!testCase.apiKey)(
				`${testCase.name} accepts forced eager_input_streaming`,
				{ retry: 2 },
				async () => {
					await expectToolEnabledRequestAccepted(model, testCase.apiKey);
				},
			);
		}
	});
});
