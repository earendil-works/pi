import { describe, expect, it } from "vitest";
import { getBuiltinModel, getBuiltinModels } from "../src/providers/all.ts";

describe("LLM Gateway models", () => {
	it("registers glm-4.5v against the gateway endpoint with pi attribution", () => {
		const model = getBuiltinModel("llmgateway", "glm-4.5v");

		expect(model).toMatchObject({
			api: "openai-completions",
			provider: "llmgateway",
			baseUrl: "https://api.llmgateway.io/v1",
			headers: { "x-source": "pi-agent" },
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 128000,
			maxTokens: 16000,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				maxTokensField: "max_tokens",
				supportsStrictMode: false,
			},
		});
	});

	it("attributes every catalog entry to pi so the gateway can bill per agent", () => {
		for (const provider of ["llmgateway", "llmgateway-devpass"] as const) {
			const models = getBuiltinModels(provider);
			expect(models.length).toBeGreaterThan(0);
			expect(models.every((model) => model.headers?.["x-source"] === "pi-agent")).toBe(true);
			expect(models.every((model) => model.baseUrl === "https://api.llmgateway.io/v1")).toBe(true);
		}
	});

	it("routes anthropic-backed models through the anthropic cache-control format", () => {
		expect(getBuiltinModel("llmgateway", "claude-haiku-4-5").compat?.cacheControlFormat).toBe("anthropic");
		expect(getBuiltinModel("llmgateway", "glm-4.5v").compat?.cacheControlFormat).toBeUndefined();
	});

	it("narrows the DevPass catalog to models a coding plan covers", () => {
		const payg = new Set(getBuiltinModels("llmgateway").map((model) => model.id));
		const devpass = new Set(getBuiltinModels("llmgateway-devpass").map((model) => model.id));

		// DevPass keys 403 on anything outside the coding plan, so its catalog is a
		// strict subset of pay-as-you-go.
		expect(devpass.size).toBeLessThan(payg.size);
		for (const id of devpass) {
			expect(payg.has(id)).toBe(true);
		}

		// Free and non-coding tiers stay out.
		expect(devpass.has("claude-haiku-4-5-free")).toBe(false);
		expect(devpass.has("claude-haiku-4-5")).toBe(true);
	});

	it("keeps DevPass models on their own provider id", () => {
		const model = getBuiltinModel("llmgateway-devpass", "glm-4.6");

		expect(model.provider).toBe("llmgateway-devpass");
		expect(model.baseUrl).toBe("https://api.llmgateway.io/v1");
	});
});
