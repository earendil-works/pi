import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/compat.ts";

describe("getSupportedThinkingLevels", () => {
	it("includes max but not xhigh for Anthropic Opus 4.6 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it("includes xhigh and max for Anthropic Opus 4.8 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
	});

	it("includes max but not xhigh for Anthropic Sonnet 4.6 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-sonnet-4-6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it("includes xhigh and max for Anthropic Sonnet 5 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-sonnet-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
	});

	it("includes xhigh and max but not off for Anthropic Claude Fable 5 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-fable-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("off");
	});

	it("does not include xhigh or max for Claude Sonnet 4.5", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).not.toContain("max");
	});

	it.each(["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const)(
		"includes xhigh for openai-codex %s models",
		(modelId) => {
			const model = getModel("openai-codex", modelId);
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		},
	);

	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const)(
		"includes xhigh and max for OpenAI %s models",
		(modelId) => {
			const model = getModel("openai", modelId);
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toEqual([
				"off",
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
		},
	);

	it("includes only medium/high/xhigh for OpenAI GPT-5.5 Pro", () => {
		const model = getModel("openai", "gpt-5.5-pro");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["medium", "high", "xhigh"]);
	});

	it("includes only medium/high/xhigh for OpenRouter GPT-5.5 Pro", () => {
		const model = getModel("openrouter", "openai/gpt-5.5-pro");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["medium", "high", "xhigh"]);
	});

	it("includes only high/max plus off for DeepSeek V4 Flash on the DeepSeek provider", () => {
		const model = getModel("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "max"]);
	});

	it("includes only high/max plus off for DeepSeek V4 Flash on opencode-go", () => {
		const model = getModel("opencode-go", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "max"]);
	});

	it("includes only high plus off for OpenCode Go Kimi K2.6", () => {
		const model = getModel("opencode-go", "kimi-k2.6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high"]);
	});

	it("excludes thinking off for Moonshot Kimi K2.7 Code models", () => {
		const cases = [getModel("moonshotai", "kimi-k2.7-code"), getModel("moonshotai-cn", "kimi-k2.7-code")];

		for (const model of cases) {
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toEqual(["minimal", "low", "medium", "high"]);
		}
	});

	it("includes only max for Kimi Coding K3", () => {
		const model = getModel("kimi-coding", "k3");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["max"]);
	});

	it("includes only high for OpenCode Grok Build", () => {
		const model = getModel("opencode", "grok-build-0.1");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["high"]);
	});

	it("includes only high/xhigh plus off for DeepSeek V4 Flash on OpenRouter", () => {
		const model = getModel("openrouter", "deepseek/deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "xhigh"]);
	});

	it("includes max but not xhigh for OpenRouter Opus 4.6 (openai-completions API)", () => {
		const model = getModel("openrouter", "anthropic/claude-opus-4.6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it("includes xhigh and max but not off for Bedrock Claude Fable 5", () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("off");
	});
});
