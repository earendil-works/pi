import { describe, expect, it } from "vitest";
import { clampOpenRouterFreeVariantLimits } from "../scripts/openrouter-variant-limits.ts";

function model(partial: { id: string; provider?: string; maxTokens: number; contextWindow: number }) {
	return {
		provider: partial.provider ?? "openrouter",
		id: partial.id,
		maxTokens: partial.maxTokens,
		contextWindow: partial.contextWindow,
	};
}

describe("clampOpenRouterFreeVariantLimits", () => {
	// #8760
	it("clamps OpenRouter :free maxTokens and contextWindow down to the base model", () => {
		const base = model({
			id: "minimax/minimax-m3",
			maxTokens: 512000,
			contextWindow: 524288,
		});
		const free = model({
			id: "minimax/minimax-m3:free",
			maxTokens: 943718,
			contextWindow: 1048576,
		});

		clampOpenRouterFreeVariantLimits([base, free]);

		expect(free.maxTokens).toBe(512000);
		expect(free.contextWindow).toBe(524288);
		expect(base.maxTokens).toBe(512000);
		expect(base.contextWindow).toBe(524288);
	});

	it("does not raise free-variant limits when they are already below the base", () => {
		const base = model({
			id: "acme/widget",
			maxTokens: 128000,
			contextWindow: 256000,
		});
		const free = model({
			id: "acme/widget:free",
			maxTokens: 8192,
			contextWindow: 32000,
		});

		clampOpenRouterFreeVariantLimits([base, free]);

		expect(free.maxTokens).toBe(8192);
		expect(free.contextWindow).toBe(32000);
	});

	it("leaves free variants unchanged when no base model exists", () => {
		const free = model({
			id: "orphan/model:free",
			maxTokens: 943718,
			contextWindow: 1048576,
		});

		clampOpenRouterFreeVariantLimits([free]);

		expect(free.maxTokens).toBe(943718);
		expect(free.contextWindow).toBe(1048576);
	});

	it("ignores non-openrouter providers and non-:free ids", () => {
		const paid = model({
			id: "minimax/minimax-m3",
			provider: "openrouter",
			maxTokens: 512000,
			contextWindow: 524288,
		});
		const otherProviderFree = model({
			id: "minimax/minimax-m3:free",
			provider: "vercel-ai-gateway",
			maxTokens: 943718,
			contextWindow: 1048576,
		});
		const openrouterPaid = model({
			id: "minimax/minimax-m3",
			provider: "openrouter",
			maxTokens: 999999,
			contextWindow: 999999,
		});

		clampOpenRouterFreeVariantLimits([paid, otherProviderFree, openrouterPaid]);

		expect(otherProviderFree.maxTokens).toBe(943718);
		expect(openrouterPaid.maxTokens).toBe(999999);
	});
});
