import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { getBuiltinModels } from "../src/providers/all.ts";

const originalDeepInfraApiKey = process.env.DEEPINFRA_API_KEY;

afterEach(() => {
	if (originalDeepInfraApiKey === undefined) {
		delete process.env.DEEPINFRA_API_KEY;
	} else {
		process.env.DEEPINFRA_API_KEY = originalDeepInfraApiKey;
	}
});

describe("DeepInfra models", () => {
	const models = getBuiltinModels("deepinfra");

	it("registers a non-empty OpenAI-compatible chat catalog", () => {
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.api).toBe("openai-completions");
			expect(model.provider).toBe("deepinfra");
			expect(model.baseUrl).toBe("https://api.deepinfra.com/v1/openai");
		}
	});

	it("applies DeepInfra OpenAI-compatible quirks to every model", () => {
		for (const model of models) {
			// Output budget is capped below the (mis-reported) full context window.
			expect(model.maxTokens).toBeLessThanOrEqual(131072);
			expect(model.maxTokens).toBeLessThanOrEqual(model.contextWindow);
			expect(model.compat).toMatchObject({
				supportsStore: false,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
				supportsLongCacheRetention: false,
			});
		}
	});

	it("only disables reasoning_effort on reasoning models", () => {
		for (const model of models) {
			if (model.compat?.supportsReasoningEffort === false) {
				expect(model.reasoning).toBe(true);
			}
		}
	});

	it("resolves DEEPINFRA_API_KEY from the environment", () => {
		process.env.DEEPINFRA_API_KEY = "test-deepinfra-key";

		expect(findEnvKeys("deepinfra")).toEqual(["DEEPINFRA_API_KEY"]);
		expect(getEnvApiKey("deepinfra")).toBe("test-deepinfra-key");
	});
});
