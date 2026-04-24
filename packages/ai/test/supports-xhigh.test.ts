import { describe, expect, it } from "vitest";
import { getModel, supportsXhigh } from "../src/models.js";

describe("supportsXhigh", () => {
	it("returns true for Anthropic Opus 4.6 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-6");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});

	it("returns true for Anthropic Opus 4.7 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-7");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});

	it("returns false for non-Opus Anthropic models", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(false);
	});

	it.each(["gpt-5.4", "gpt-5.5"] as const)("returns true for %s models", (modelId) => {
		const model = getModel("openai-codex", modelId);
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});

	it("returns true for OpenRouter Opus 4.6 (openai-completions API)", () => {
		const model = getModel("openrouter", "anthropic/claude-opus-4.6");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});
});
