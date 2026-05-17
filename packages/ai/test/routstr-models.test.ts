import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel } from "../src/models.js";

const originalRoutstrApiKey = process.env.ROUTSTR_API_KEY;

afterEach(() => {
	if (originalRoutstrApiKey === undefined) {
		delete process.env.ROUTSTR_API_KEY;
	} else {
		process.env.ROUTSTR_API_KEY = originalRoutstrApiKey;
	}
});

describe("Routstr models", () => {
	it("registers the default Kimi K2.6 model via OpenAI-compatible Chat Completions API", () => {
		const model = getModel("routstr", "kimi-k2.6");

		expect(model).toBeDefined();
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("routstr");
		expect(model.baseUrl).toBe("https://api.routstr.com/v1");
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBeGreaterThan(0);
		expect(model.maxTokens).toBeGreaterThan(0);
		expect(model.compat).toMatchObject({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
		});
	});

	it("maps Routstr model metadata from its OpenAI-compatible model structure", () => {
		const model = getModel("routstr", "claude-opus-4.7-fast");

		expect(model).toBeDefined();
		expect(model.name).toBe("Anthropic: Claude Opus 4.7 (Fast)");
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("routstr");
		expect(model.baseUrl).toBe("https://api.routstr.com/v1");
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1000000);
		expect(model.maxTokens).toBe(128000);
		expect(model.cost.input).toBeGreaterThan(0);
		expect(model.cost.output).toBeGreaterThan(0);
		expect(model.cost.cacheRead).toBeGreaterThan(0);
		expect(model.cost.cacheWrite).toBeGreaterThan(0);
	});

	it("resolves ROUTSTR_API_KEY from the environment", () => {
		process.env.ROUTSTR_API_KEY = "test-routstr-key";

		expect(findEnvKeys("routstr")).toEqual(["ROUTSTR_API_KEY"]);
		expect(getEnvApiKey("routstr")).toBe("test-routstr-key");
	});
});
