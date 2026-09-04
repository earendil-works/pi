import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { orcaRouterTextChatModels } from "../src/orcarouter/capabilities.ts";
import { orcarouterProvider } from "../src/providers/orcarouter.ts";

/**
 * Live tests for the OrcaRouter provider. These run against the real
 * `https://api.orcarouter.ai/v1/models` catalog. They are skipped unless
 * ORCAROUTER_API_KEY is set so they never run in plain CI; a Bearer key lets
 * the catalog reflect the workspace's callable models.
 */

const envKey = process.env.ORCAROUTER_API_KEY;

const describeLive = envKey ? describe : describe.skip;

describeLive("OrcaRouter live catalog through the provider path", () => {
	it("refreshes models over the network through createModels refresh()", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("orcarouter", async () => ({ type: "api_key", key: envKey }));
		const models = createModels({ credentials });
		models.setProvider(orcarouterProvider());

		// Empty before the first refresh: dynamic provider with no hand-written baseline.
		expect(models.getModels("orcarouter")).toEqual([]);

		const result = await models.refresh({ providers: ["orcarouter"] });
		expect(result.errors.size).toBe(0);

		const orcaModels = models.getModels("orcarouter");
		expect(orcaModels.length).toBeGreaterThan(0);
		for (const model of orcaModels) {
			expect(model.provider).toBe("orcarouter");
			// openai-completions posts to baseUrl/chat/completions; anthropic-messages models use the origin
			// so the Anthropic SDK appends /v1/messages once.
			expect(model.baseUrl).toBe(
				model.api === "anthropic-messages" ? "https://api.orcarouter.ai" : "https://api.orcarouter.ai/v1",
			);
			// Chat-capable only: never image-generation / embeddings / video endpoints.
			expect(model.input).toContain("text");
			expect(model.id.length).toBeGreaterThan(0);
		}
	});

	it("exposes the live catalog to the capability filter for text and image chat", async () => {
		const { fetchOrcaRouterCatalog } = await import("../src/providers/orcarouter.ts");
		const entries = await fetchOrcaRouterCatalog("https://api.orcarouter.ai/v1", envKey);
		expect(entries.length).toBeGreaterThan(0);

		const textModels = orcaRouterTextChatModels(entries);
		expect(textModels.length).toBeGreaterThan(0);

		// Every returned text model must be an OpenAI-compatible chat entry.
		for (const model of textModels) {
			expect(model.api === "openai-completions" || model.api === "anthropic-messages").toBe(true);
			expect(model.input.includes("text")).toBe(true);
		}

		// Multimodal (image) chat models are a strict subset: those that explicitly
		// declare image in architecture.input_modalities.
		const { orcaRouterMultimodalChatModels } = await import("../src/orcarouter/capabilities.ts");
		const imageModels = orcaRouterMultimodalChatModels(entries, "image");
		expect(imageModels.length).toBeGreaterThan(0);
		expect(imageModels.length).toBeLessThanOrEqual(textModels.length);
		const textIds = new Set(textModels.map((model) => model.id));
		for (const imageModel of imageModels) {
			expect(textIds.has(imageModel.id)).toBe(true);
			expect(imageModel.input).toContain("image");
		}
	});
});
