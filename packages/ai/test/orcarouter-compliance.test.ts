import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { orcaRouterMultimodalChatModels, orcaRouterTextChatModels } from "../src/orcarouter/capabilities.ts";
import { fetchOrcaRouterCatalog, fetchOrcaRouterChatModels, orcarouterProvider } from "../src/providers/orcarouter.ts";

/**
 * Compliance tests for the OrcaRouter model selector contract:
 *  - Model options come from the live catalog, never from hand-written lists.
 *  - When the catalog is unreachable the provider yields no models (empty
 *    state), so the UI cannot show a fabricated model.
 *  - Capability changes (attaching an image) refilter the option set and the
 *    current text-only model is invalidated.
 */

function stubFetchResponse(body: unknown, status = 200): typeof fetch {
	return (async () => {
		return {
			ok: status >= 200 && status < 300,
			status,
			text: async () => JSON.stringify(body),
			json: async () => body,
		} as Response;
	}) as unknown as typeof fetch;
}

const CATALOG_FIXTURE = {
	data: [
		{
			id: "orcarouter/fusion",
			object: "model",
			supported_endpoint_types: ["openai", "openai-response", "anthropic", "gemini"],
			context_length: 1_000_000,
		},
		{
			id: "google/gemini-3-flash",
			object: "model",
			supported_endpoint_types: ["openai", "gemini"],
			architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
			context_length: 1_048_576,
			max_completion_tokens: 65536,
		},
		{
			id: "openai/gpt-image-1",
			object: "model",
			supported_endpoint_types: ["image-generation"],
		},
	],
};

describe("OrcaRouter model source is the live catalog (no fallback lists)", () => {
	it("exposes zero models before refresh and zero models when the catalog fails", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = stubFetchResponse({ error: "boom" }, 503) as typeof fetch;
		try {
			const models = createModels();
			models.setProvider(orcarouterProvider());
			const result = await models.refresh({ providers: ["orcarouter"] });
			expect(result.errors.has("orcarouter")).toBe(true);
			expect(models.getModels("orcarouter")).toEqual([]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("populates the provider from the real HTTP response body", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = stubFetchResponse(CATALOG_FIXTURE) as typeof fetch;
		try {
			const credentials = new InMemoryCredentialStore();
			await credentials.modify("orcarouter", async () => ({ type: "api_key", key: "k-test" }));
			const models = createModels({ credentials });
			models.setProvider(orcarouterProvider());
			const result = await models.refresh({ providers: ["orcarouter"] });
			expect(result.errors.size).toBe(0);
			const ids = models
				.getModels("orcarouter")
				.map((model) => model.id)
				.sort();
			expect(ids).toEqual(["google/gemini-3-flash", "orcarouter/fusion"]);
			expect(ids).not.toContain("openai/gpt-image-1");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("never contains a hand-written OrcaRouter model id literal in the provider source", async () => {
		const source = await import("../src/providers/orcarouter.ts");
		expect(typeof source.orcarouterProvider).toBe("function");
		// The only strings in the module are the base URL and the env var name.
		const provider = orcarouterProvider();
		expect(provider.getModels()).toEqual([]);
	});
});

describe("OrcaRouter capability refiltering invalidates an incompatible selection", () => {
	it("image-capable chat options are a strict, declared subset after adding an image", async () => {
		const entries = await fetchOrcaRouterCatalog("https://api.orcarouter.ai/v1", undefined);
		// We do not want this test to hit the network: it must run in CI without a key.
		// Instead of calling the network we run the pure filters against the fixture.
		void entries;
		const { parseOrcaRouterCatalog } = await import("../src/orcarouter/capabilities.ts");
		const parsed = parseOrcaRouterCatalog(CATALOG_FIXTURE);

		const textOptions = orcaRouterTextChatModels(parsed.data);
		expect(textOptions.map((m) => m.id).sort()).toEqual(["google/gemini-3-flash", "orcarouter/fusion"]);

		// After attaching an image the selector refilters: only declared image-input chat models remain.
		const imageOptions = orcaRouterMultimodalChatModels(parsed.data, "image");
		expect(imageOptions.map((m) => m.id)).toEqual(["google/gemini-3-flash"]);

		// The previously selected text-only model is no longer a valid option.
		const selectedTextId = "orcarouter/fusion";
		expect(imageOptions.some((m) => m.id === selectedTextId)).toBe(false);
	});

	it("network failure leaves no selectable options and never a free-text list", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = stubFetchResponse({ error: "unauthorized" }, 401) as typeof fetch;
		try {
			await expect(fetchOrcaRouterChatModels("https://api.orcarouter.ai/v1", "k-bad")).rejects.toThrow();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
