import { describe, expect, it } from "vitest";
import type { Usage } from "../src/types.ts";
import { applyOpenRouterReportedCost, isOpenRouterModel } from "../src/utils/openrouter-cost.ts";

function usage(total = 1): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0.25, output: 0.75, cacheRead: 0, cacheWrite: 0, total },
	};
}

describe("isOpenRouterModel", () => {
	it("recognizes both the built-in provider and custom providers using OpenRouter's endpoint", () => {
		expect(isOpenRouterModel({ provider: "openrouter", baseUrl: "https://example.com" })).toBe(true);
		expect(isOpenRouterModel({ provider: "openrouter-work", baseUrl: "https://openrouter.ai/api/v1" })).toBe(true);
		expect(isOpenRouterModel({ provider: "custom", baseUrl: "https://example.com/v1" })).toBe(false);
	});
});

describe("applyOpenRouterReportedCost", () => {
	it("uses OpenRouter's reported cost for non-BYOK requests", () => {
		const value = usage();
		applyOpenRouterReportedCost(value, {
			cost: 0,
			is_byok: false,
			cost_details: {
				upstream_inference_cost: 0,
				upstream_inference_prompt_cost: 0,
				upstream_inference_completions_cost: 0,
			},
		});
		expect(value.cost.total).toBe(0);
	});

	it("adds the upstream inference cost for BYOK requests", () => {
		const value = usage();
		applyOpenRouterReportedCost(value, {
			cost: 0.1,
			is_byok: true,
			cost_details: {
				upstream_inference_cost: 0.9,
				upstream_inference_prompt_cost: 0.6,
				upstream_inference_completions_cost: 0.3,
			},
		});
		expect(value.cost.total).toBe(1);
	});

	it("uses upstream cost components when OpenRouter omits their total", () => {
		const value = usage();
		applyOpenRouterReportedCost(value, {
			cost: 0.1,
			is_byok: true,
			cost_details: {
				upstream_inference_cost: null,
				upstream_inference_prompt_cost: 0.6,
				upstream_inference_completions_cost: 0.3,
			},
		});
		expect(value.cost.total).toBeCloseTo(1);
	});
});
