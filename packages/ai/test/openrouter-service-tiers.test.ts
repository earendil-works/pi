import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenRouterCatalog } from "../catalog/sources/openrouter.ts";
import type { RefreshModelsContext } from "../src/models.ts";
import { personalizeOpenRouterCatalog } from "../src/providers/openrouter.ts";
import { openRouterServiceTiers } from "../src/providers/openrouter-api.ts";
import type { AnyModel, Model } from "../src/types.ts";

function chatModel(id: string, serviceTiers?: { id: string; name: string }[]): Model<"openai-completions"> {
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
		...(serviceTiers && { serviceTiers }),
	};
}

function refreshContext(): RefreshModelsContext {
	return {
		credential: { type: "api_key", key: "sk-or-test" },
		publish: async () => true,
		allowNetwork: true,
		signal: new AbortController().signal,
	};
}

function stubUserModels(data: unknown[]): void {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data }));
}

afterEach(() => vi.restoreAllMocks());

describe("openRouterServiceTiers", () => {
	it("labels the tiers OpenRouter names, cheapest first", () => {
		expect(openRouterServiceTiers(["flex", "priority", "ultrafast"])).toEqual([
			{ id: "flex", name: "Flex" },
			{ id: "priority", name: "Priority" },
			{ id: "ultrafast", name: "Ultrafast" },
		]);
	});

	it("labels a tier Pi has not seen yet by its id, so a new tier needs no release", () => {
		expect(openRouterServiceTiers(["turbo"])).toEqual([{ id: "turbo", name: "Turbo" }]);
	});

	it("distinguishes a listing that does not say from one that names no tier", () => {
		expect(openRouterServiceTiers(undefined)).toBeUndefined();
		expect(openRouterServiceTiers(null)).toBeUndefined();
		expect(openRouterServiceTiers([])).toEqual([]);
	});
});

describe("buildOpenRouterCatalog service tiers", () => {
	it("carries a model's tiers into its catalog entry", () => {
		const catalog = buildOpenRouterCatalog(
			[
				{
					id: "openai/gpt-sol",
					name: "GPT Sol",
					supported_parameters: ["tools"],
					service_tiers: ["priority", "ultrafast"],
				},
			],
			[],
			[],
		);

		expect(catalog.chat[0]?.serviceTiers).toEqual([
			{ id: "priority", name: "Priority" },
			{ id: "ultrafast", name: "Ultrafast" },
		]);
	});

	it("omits the field for a model with no tier, and for a listing that does not report tiers", () => {
		const catalog = buildOpenRouterCatalog(
			[
				{ id: "untiered", name: "Untiered", supported_parameters: ["tools"], service_tiers: [] },
				{ id: "unreported", name: "Unreported", supported_parameters: ["tools"] },
			],
			[],
			[],
		);

		expect(catalog.chat.map((model) => "serviceTiers" in model)).toEqual([false, false]);
	});
});

describe("personalizeOpenRouterCatalog service tiers", () => {
	it("takes the key's tiers, so a tier added later needs no Pi release", async () => {
		stubUserModels([{ id: "listed", service_tiers: ["priority", "ultrafast"] }]);
		const catalog: AnyModel[] = [chatModel("listed")];

		const personalized = await personalizeOpenRouterCatalog(catalog, refreshContext());

		expect(personalized[0]).toMatchObject({
			serviceTiers: [
				{ id: "priority", name: "Priority" },
				{ id: "ultrafast", name: "Ultrafast" },
			],
		});
	});

	it("keeps the catalog tiers when the listing does not report them", async () => {
		stubUserModels([{ id: "listed" }]);
		const catalog: AnyModel[] = [chatModel("listed", [{ id: "priority", name: "Priority" }])];

		const personalized = await personalizeOpenRouterCatalog(catalog, refreshContext());

		expect(personalized[0]).toMatchObject({ serviceTiers: [{ id: "priority", name: "Priority" }] });
	});

	it("drops the catalog tiers when the listing says the model sells none", async () => {
		stubUserModels([{ id: "listed", service_tiers: [] }]);
		const catalog: AnyModel[] = [chatModel("listed", [{ id: "priority", name: "Priority" }])];

		const personalized = await personalizeOpenRouterCatalog(catalog, refreshContext());

		expect(personalized[0]).toMatchObject({ serviceTiers: [] });
	});
});
