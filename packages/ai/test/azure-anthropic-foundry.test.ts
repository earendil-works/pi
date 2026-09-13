import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModels } from "../src/models.ts";
import { builtinProviders } from "../src/providers/all.ts";

const ENV_KEYS = ["ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_FOUNDRY_RESOURCE"] as const;
const original = new Map<string, string | undefined>();

function models() {
	const registry = createModels();
	for (const provider of builtinProviders()) registry.setProvider(provider);
	return registry;
}

beforeEach(() => {
	for (const key of ENV_KEYS) {
		original.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = original.get(key);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

describe("azure-anthropic-foundry", () => {
	it("registers the provider with anthropic-messages models", () => {
		const provider = models().getProvider("azure-anthropic-foundry");
		expect(provider).toBeDefined();
		const catalog = provider?.getModels() ?? [];
		expect(catalog.length).toBeGreaterThan(0);
		for (const model of catalog) {
			expect(model.api).toBe("anthropic-messages");
			expect(model.provider).toBe("azure-anthropic-foundry");
		}
	});

	it("derives the base URL from the resource name", async () => {
		process.env.ANTHROPIC_FOUNDRY_API_KEY = "test-key";
		process.env.ANTHROPIC_FOUNDRY_RESOURCE = "my-resource";

		const auth = await models().getAuth("azure-anthropic-foundry");

		expect(auth?.auth.baseUrl).toBe("https://my-resource.services.ai.azure.com/anthropic/");
		expect(auth?.source).toBe("ANTHROPIC_FOUNDRY_API_KEY");
	});

	it("prefers an explicit base URL and normalizes the trailing slash", async () => {
		process.env.ANTHROPIC_FOUNDRY_API_KEY = "test-key";
		process.env.ANTHROPIC_FOUNDRY_RESOURCE = "my-resource";
		process.env.ANTHROPIC_FOUNDRY_BASE_URL = "https://custom.example.com/anthropic";

		const auth = await models().getAuth("azure-anthropic-foundry");

		expect(auth?.auth.baseUrl).toBe("https://custom.example.com/anthropic/");
	});

	// Azure gateways authenticate with `api-key`; the Anthropic SDK only sends `x-api-key`.
	it("mirrors the key into an api-key header", async () => {
		process.env.ANTHROPIC_FOUNDRY_API_KEY = "test-key";
		process.env.ANTHROPIC_FOUNDRY_RESOURCE = "my-resource";

		const auth = await models().getAuth("azure-anthropic-foundry");

		expect(auth?.auth.apiKey).toBe("test-key");
		expect(auth?.auth.headers).toMatchObject({ "api-key": "test-key" });
	});

	it("is unconfigured without an api key", async () => {
		process.env.ANTHROPIC_FOUNDRY_RESOURCE = "my-resource";

		expect(await models().getAuth("azure-anthropic-foundry")).toBeUndefined();
	});

	it("rejects when no endpoint is configured", async () => {
		process.env.ANTHROPIC_FOUNDRY_API_KEY = "test-key";

		await expect(models().getAuth("azure-anthropic-foundry")).rejects.toThrow(
			/ANTHROPIC_FOUNDRY_RESOURCE or ANTHROPIC_FOUNDRY_BASE_URL/,
		);
	});
});
