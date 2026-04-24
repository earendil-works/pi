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

	it("returns true for DeepSeek V4 Pro on native deepseek provider (openai-completions API)", () => {
		const model = getModel("deepseek", "deepseek-v4-pro");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});

	it("returns true for DeepSeek V4 Pro on openrouter (openai-completions API)", () => {
		const model = getModel("openrouter", "deepseek/deepseek-v4-pro");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});

	it("returns true for DeepSeek V4 Pro on vercel-ai-gateway (anthropic-messages API)", () => {
		const model = getModel("vercel-ai-gateway", "deepseek/deepseek-v4-pro");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(true);
	});

	it("returns false for DeepSeek V4 Flash (does not support max effort)", () => {
		const model = getModel("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(false);
	});

	it("returns false for older DeepSeek models (bedrock)", () => {
		const model = getModel("amazon-bedrock", "deepseek.v3.2");
		expect(model).toBeDefined();
		expect(supportsXhigh(model!)).toBe(false);
	});
});
