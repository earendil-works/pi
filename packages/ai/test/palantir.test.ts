import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { resolvePalantirApiKey, resolvePalantirBaseUrl } from "../src/providers/palantir.ts";

describe("Palantir Proxy Provider", () => {
	it("resolves base URL correctly with placeholder replacement", () => {
		const model = getModel("palantir", "ri.language-model-service..language-model.gpt-4-o");
		expect(model).toBeDefined();

		// Set custom base url
		const customBaseUrl = "https://saigedev.palantirfoundry.com";
		const resolvedUrl = resolvePalantirBaseUrl(model, customBaseUrl);

		expect(resolvedUrl).toBe("https://saigedev.palantirfoundry.com/api/v2/llm/proxy/openai/v1");
	});

	it("resolves API key correctly", () => {
		const customApiKey = "test-api-key";
		expect(resolvePalantirApiKey(customApiKey)).toBe("test-api-key");
	});

	it("detects reasoning models appropriately", () => {
		const model = getModel("palantir", "ri.language-model-service..language-model.gemini-2-5-pro");
		expect(model.reasoning).toBe(true);
	});

	it("correctly identifies upstream api type", () => {
		const gpt4o = getModel("palantir", "ri.language-model-service..language-model.gpt-4-o");
		const sonnet = getModel("palantir", "ri.language-model-service..language-model.anthropic-claude-4-sonnet");
		const gemini = getModel("palantir", "ri.language-model-service..language-model.gemini-2-5-pro");

		expect(gpt4o.api).toBe("palantir-proxy");
		expect(sonnet.api).toBe("palantir-proxy");
		expect(gemini.api).toBe("palantir-proxy");

		// The actual routing happens inside streamPalantir, but we can test the models have the right proxy path
		expect(gpt4o.baseUrl).toContain("openai/v1");
		expect(sonnet.baseUrl).toContain("anthropic/v1");
		expect(gemini.baseUrl).toContain("google/v1");
	});
});
