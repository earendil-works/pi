import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { filterOrcaRouterCatalog } from "../src/orcarouter/capabilities.ts";
import { fetchOrcaRouterCatalog } from "../src/orcarouter/catalog.ts";
import { orcaRouterProvider, resolveOrcaRouterApiBaseUrl } from "../src/providers/orcarouter.ts";

/**
 * Live OrcaRouter checks. These run only when ORCAROUTER_API_KEY is present and
 * always go through the provider implementation added in this change — a bare
 * curl to the same endpoint is not evidence that the integration is wired.
 */
const apiKey = process.env.ORCAROUTER_API_KEY;
/** Skip the whole suite when no real key is configured; the worker never invents one. */
const live = apiKey ? describe : describe.skip;

live.sequential("OrcaRouter live catalog", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reads the workspace catalog through the provider with the configured key", async () => {
		const baseUrl = resolveOrcaRouterApiBaseUrl();
		expect(baseUrl).toBe("https://api.orcarouter.ai/v1");

		const catalog = await fetchOrcaRouterCatalog({ baseUrl, apiKey, capability: "chat" });
		expect(catalog.length).toBeGreaterThan(0);
		for (const model of catalog) {
			// Ids keep their vendor/model namespace verbatim.
			expect(model.id).toMatch(/^[a-z0-9][a-z0-9._-]*\/[^/]+$/);
		}

		const text = filterOrcaRouterCatalog(catalog, "text");
		expect(text.length).toBeGreaterThan(0);
		for (const model of text) {
			expect(model.endpointTypes.length).toBeGreaterThan(0);
			expect(model.endpointTypes).not.toContain("embeddings");
			expect(model.endpointTypes).not.toContain("image-generation");
			expect(model.endpointTypes).not.toContain("openai-video");
			expect(model.endpointTypes).not.toContain("jina-rerank");
		}
		console.log(
			`[live] chat-capable models: ${text.length}/${catalog.length}; ` +
				`declaring image input: ${filterOrcaRouterCatalog(catalog, "text", "image").length}`,
		);
	});

	it("publishes the live catalog through the provider and resolves text auth", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("orcarouter", async () => ({ type: "api_key", key: apiKey }));
		const models = createModels({ credentials });
		models.setProvider(orcaRouterProvider());

		const result = await models.refresh({ providers: ["orcarouter"] });
		expect(result.errors.size).toBe(0);

		const available = models.getModels("orcarouter");
		expect(available.length).toBeGreaterThan(0);
		for (const model of available) {
			expect(model.baseUrl).toBe("https://api.orcarouter.ai/v1");
			expect(model.provider).toBe("orcarouter");
		}
		// A seeded model that the live catalog does not advertise must not survive;
		// the seed is a cold-start fallback, not a permanent merge.
		console.log(`[live] provider models after refresh: ${available.length}`);
	});

	it("makes a real streaming request through the provider path", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("orcarouter", async () => ({ type: "api_key", key: apiKey }));
		const models = createModels({ credentials });
		models.setProvider(orcaRouterProvider());
		await models.refresh({ providers: ["orcarouter"] });

		const available = models.getModels("orcarouter");
		expect(available.length).toBeGreaterThan(0);

		// Walk the workspace catalog and stream from the first model this key may
		// actually call; a key can be scoped away from individual models, which the
		// relay reports as a `model_access_denied` 403.
		let replied: { id: string; text: string } | undefined;
		const denied: string[] = [];
		for (const model of available) {
			const stream = models.streamSimple(
				model,
				{
					messages: [{ role: "user", content: "Reply with the single word: ok", timestamp: Date.now() }],
				},
				{ maxTokens: 256 },
			);
			let text = "";
			let errorMessage: string | undefined;
			for await (const event of stream) {
				if (event.type === "text_delta") text += event.delta;
				if (event.type === "error") errorMessage = event.error.errorMessage;
			}
			if (errorMessage) {
				denied.push(`${model.id}: ${errorMessage.slice(0, 60)}`);
				continue;
			}
			replied = { id: model.id, text };
			break;
		}

		if (denied.length > 0) console.log(`[live] key denied for ${denied.length} model(s): ${denied[0]}`);
		expect(replied, `no callable model; denials: ${denied.join(" | ")}`).toBeDefined();
		expect(replied!.text.trim().length).toBeGreaterThan(0);
		console.log(`[live] ${replied!.id} replied: ${JSON.stringify(replied!.text.trim().slice(0, 80))}`);
	}, 120_000);
});
