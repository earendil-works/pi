import { describe, expect, it } from "vitest";
import { buildParams } from "../src/providers/google.js";
import type { Context, Model } from "../src/types.js";

function makeModel(overrides: Partial<Model<"google-generative-ai">> = {}): Model<"google-generative-ai"> {
	return {
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
		...overrides,
	};
}

const minimalContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

describe("buildParams thinkingConfig for reasoning models", () => {
	it("sets thinkingConfig when thinking is enabled on a reasoning model", () => {
		const params = buildParams(makeModel(), minimalContext, {
			thinking: { enabled: true, budgetTokens: 4096 },
		});
		expect(params.config?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: 4096,
		});
	});

	it("explicitly disables thinking on a reasoning model when thinking.enabled is false", () => {
		const params = buildParams(makeModel(), minimalContext, {
			thinking: { enabled: false },
		});
		expect(params.config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
	});

	it("preserves API default when thinking option is omitted on a reasoning model", () => {
		const params = buildParams(makeModel(), minimalContext, {});
		expect(params.config?.thinkingConfig).toBeUndefined();
	});

	it("does not set thinkingConfig on a non-reasoning model", () => {
		const params = buildParams(makeModel({ reasoning: false }), minimalContext, {});
		expect(params.config?.thinkingConfig).toBeUndefined();
	});

	it("does not set thinkingConfig on a non-reasoning model even with thinking.enabled", () => {
		const params = buildParams(makeModel({ reasoning: false }), minimalContext, {
			thinking: { enabled: true, budgetTokens: 4096 },
		});
		expect(params.config?.thinkingConfig).toBeUndefined();
	});

	it("does not set thinkingConfig on a non-reasoning model with thinking.enabled false", () => {
		const params = buildParams(makeModel({ reasoning: false }), minimalContext, {
			thinking: { enabled: false },
		});
		expect(params.config?.thinkingConfig).toBeUndefined();
	});
});
