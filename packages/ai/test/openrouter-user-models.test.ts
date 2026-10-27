import { afterEach, describe, expect, it, vi } from "vitest";
import type { RefreshModelsContext } from "../src/models.ts";
import { personalizeOpenRouterCatalog } from "../src/providers/openrouter.ts";
import type { OpenRouterModel } from "../src/providers/openrouter-api.ts";
import type { AnyModel, ClassifierModel, ImageModel, Model } from "../src/types.ts";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function chatModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 50_000,
	};
}

const imageModel: ImageModel<"openrouter-images"> = {
	type: "image",
	id: "image",
	name: "image",
	api: "openrouter-images",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	input: ["text"],
	output: ["image"],
	cost: zeroCost,
};

const classifierModel: ClassifierModel<"typesafe-system-one"> = {
	type: "classifier",
	id: "classifier",
	name: "classifier",
	api: "typesafe-system-one",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	input: ["text"],
	cost: zeroCost,
	contextWindow: 64_000,
};

function refreshContext(): RefreshModelsContext {
	return {
		credential: { type: "api_key", key: "sk-or-test" },
		publish: async () => true,
		allowNetwork: true,
		signal: new AbortController().signal,
	};
}

function stubUserModels(response: Response): void {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
}

afterEach(() => vi.restoreAllMocks());

describe("personalizeOpenRouterCatalog", () => {
	it("keeps only the key's chat models, with the key's limits and prices", async () => {
		const data: OpenRouterModel[] = [
			{
				id: "listed",
				context_length: 1_000_000,
				top_provider: { context_length: 262_144, max_completion_tokens: 32_768 },
				pricing: { prompt: "0.000003", completion: "0.000015" },
			},
			// A missing limit keeps the catalog value, so generator fixes for missing OpenRouter data survive.
			{ id: "no-limits", context_length: 0, top_provider: { context_length: null, max_completion_tokens: null } },
			// Router models report -1, meaning the price depends on the model they pick.
			{ id: "router", pricing: { prompt: "-1", completion: "-1" } },
		];
		stubUserModels(Response.json({ data }));
		const catalog: AnyModel[] = [
			chatModel("listed"),
			chatModel("no-limits"),
			chatModel("router"),
			chatModel("blocked"),
			imageModel,
			classifierModel,
		];

		const result = await personalizeOpenRouterCatalog(catalog, refreshContext());

		expect(result.map((model) => model.id)).toEqual(["listed", "no-limits", "router", "image", "classifier"]);
		expect(result[0]).toMatchObject({
			contextWindow: 262_144,
			maxTokens: 32_768,
			cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		});
		expect(result[1]).toMatchObject({ contextWindow: 200_000, maxTokens: 50_000, cost: chatModel("x").cost });
		expect(result[2]).toMatchObject({ cost: zeroCost });
		// /models/user lists text models only, so image and classifier models are not filtered.
		expect(result[3]).toBe(imageModel);
		expect(result[4]).toBe(classifierModel);
	});

	it.each([401, 403, 404])(
		"returns the catalog unchanged when the endpoint rejects the key or is missing (%i)",
		async (status) => {
			// For example a proxy configured in models.json that rejects the key or has no /models/user:
			// the user keeps the full list instead of a failing refresh.
			stubUserModels(new Response("", { status }));
			const catalog = [chatModel("a")];

			expect(await personalizeOpenRouterCatalog(catalog, refreshContext())).toBe(catalog);
		},
	);
});
