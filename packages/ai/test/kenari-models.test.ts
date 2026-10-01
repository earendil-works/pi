import { describe, expect, it } from "vitest";
import { kenariModelsFromPayload, kenariProvider } from "../src/providers/kenari.ts";

const priced = {
	id: "claude-sonnet-5-5",
	name: "Sonnet",
	tool_call: true,
	reasoning: true,
	context_length: 1_000_000,
	modalities: { input: ["text", "image", "pdf"] },
	pricing: {
		input: 15_000_000_000,
		output: 75_000_000_000,
		cache_read: 1_500_000_000,
		cache_write: 18_750_000_000,
		currency: "IDR",
		unit: "micro_idr_per_1m_tokens",
	},
};

describe("kenari model list", () => {
	it("keeps tool-capable chat models and drops rupiah prices", () => {
		const models = kenariModelsFromPayload({
			data: [
				priced,
				{ id: "kenari/auto", tool_call: true, context_length: 128_000, pricing: { varies: true } },
				{ id: "embed-only", tool_call: false, context_length: 8_000 },
				{ id: "no-window", tool_call: true },
				{ id: "agnes-2-0-flash:free", tool_call: true, reasoning: false, context_length: 32_000 },
			],
		});

		expect(models.map((model) => model.id)).toEqual(["agnes-2-0-flash:free", "claude-sonnet-5-5"]);
		const sonnet = models[1];
		expect(sonnet).toMatchObject({
			provider: "kenari",
			api: "openai-completions",
			baseUrl: "https://kenari.id/v1",
			name: "Sonnet",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 8192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		expect(models[0]).toMatchObject({ reasoning: false, contextWindow: 32_000, maxTokens: 8192 });
	});

	it("rejects a body that is not a model list", () => {
		expect(() => kenariModelsFromPayload({ models: [] })).toThrow(/data array/);
	});

	it("ships a seed model before the live list loads", () => {
		const provider = kenariProvider();
		expect(provider.id).toBe("kenari");
		expect(provider.getModels().map((model) => model.id)).toEqual(["claude-sonnet-5-5"]);
		expect(provider.auth.apiKey?.login).toBeTypeOf("function");
	});
});
