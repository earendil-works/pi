import { describe, expect, it } from "vitest";
import { getAiGatewayCost } from "../scripts/ai-gateway-pricing.ts";
import { buildOpenRouterCatalog, type OpenRouterModelListItem } from "../scripts/openrouter-catalog.ts";

function openRouterChatCost(pricing: OpenRouterModelListItem["pricing"]) {
	const catalog = buildOpenRouterCatalog(
		[{ id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", supported_parameters: ["tools"], pricing }],
		[],
		[],
	);
	return catalog.chat[0]?.cost;
}

describe("OpenRouter pricing overrides", () => {
	it("turns prompt-length overrides into tiers", () => {
		expect(
			openRouterChatCost({
				prompt: "0.0000001",
				completion: "0.0000005",
				input_cache_read: "0.00000001",
				input_cache_write: "0.000000125",
				overrides: [
					{
						min_prompt_tokens: 100000,
						prompt: "0.0000005",
						completion: "0.0000025",
						input_cache_read: "0.00000005",
						input_cache_write: "0.000000625",
					},
				],
			}),
		).toEqual({
			input: 0.1,
			output: 0.5,
			cacheRead: 0.01,
			cacheWrite: 0.125,
			tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
		});
	});

	it("keeps base rates missing from an override", () => {
		expect(
			openRouterChatCost({
				prompt: "0.000002",
				completion: "0.000012",
				input_cache_read: "0.0000002",
				input_cache_write: "0.000000375",
				overrides: [{ min_prompt_tokens: 200000, prompt: "0.000004", completion: "0.000018" }],
			})?.tiers,
		).toEqual([{ inputTokensAbove: 200000, input: 4, output: 18, cacheRead: 0.2, cacheWrite: 0.375 }]);
	});

	it("skips time-of-day overrides", () => {
		expect(
			openRouterChatCost({
				prompt: "0.000000132",
				completion: "0.000000528",
				overrides: [
					{ utc_start: 0, utc_end: 1600, prompt: "0.000000132", completion: "0.000000528" },
					{ utc_days: ["saturday"], min_prompt_tokens: 1000, prompt: "0.0000001" },
				],
			}),
		).toEqual({ input: 0.132, output: 0.528, cacheRead: 0, cacheWrite: 0 });
	});
});

describe("Vercel AI Gateway pricing tiers", () => {
	it("turns bracket starts into tiers with the rates in effect there", () => {
		expect(
			getAiGatewayCost({
				input: "0.000001",
				output: "0.000005",
				input_cache_read: "0.0000002",
				input_tiers: [
					{ cost: "0.000001", min: 0, max: 32001 },
					{ cost: "0.0000018", min: 32001, max: 128001 },
					{ cost: "0.000003", min: 128001 },
				],
				output_tiers: [
					{ cost: "0.000005", min: 0, max: 32001 },
					{ cost: "0.000009", min: 32001, max: 128001 },
					{ cost: "0.000015", min: 128001 },
				],
			}),
		).toEqual({
			input: 1,
			output: 5,
			cacheRead: 0.2,
			cacheWrite: 0,
			tiers: [
				{ inputTokensAbove: 32000, input: 1.8, output: 9, cacheRead: 0.2, cacheWrite: 0 },
				{ inputTokensAbove: 128000, input: 3, output: 15, cacheRead: 0.2, cacheWrite: 0 },
			],
		});
	});

	it("returns base rates without tiers", () => {
		expect(getAiGatewayCost({ input: "0.000003", output: 0.000015 })).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});
});
