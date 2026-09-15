import { afterEach, describe, expect, it, vi } from "vitest";
import {
	capabilityQueryValue,
	filterOrcaRouterCatalog,
	isEmbeddingModel,
	isImageGenerationModel,
	isMultimodalChatModel,
	isRerankModel,
	isTextChatModel,
	isVideoModel,
	ORCAROUTER_CATALOG_MAX_BYTES,
	type OrcaRouterModelRecord,
	parseOrcaRouterCatalog,
} from "../src/orcarouter/capabilities.ts";
import {
	fetchOrcaRouterCatalog,
	ORCAROUTER_DEFAULT_API_BASE_URL,
	ORCAROUTER_FALLBACK_MODELS,
	selectOrcaRouterApi,
	toOrcaRouterModels,
} from "../src/orcarouter/catalog.ts";
import { orcaRouterProvider, resolveOrcaRouterApiBaseUrl } from "../src/providers/orcarouter.ts";

const ORIGIN = "https://api.orcarouter.ai/v1";

/**
 * A catalog fixture covering every shape the capability filters must separate:
 * text-only chat, image-input chat, a multi-endpoint chat route, and the
 * non-chat routes (embedding, image generation, video, rerank).
 */
const FIXTURE = {
	data: [
		{
			id: "deepseek/deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			context_length: 1048576,
			max_completion_tokens: 384000,
			supported_endpoint_types: ["openai", "openai-response"],
			architecture: { input_modalities: ["text"] },
			pricing: { prompt: "0.0000006600", completion: "0.0000019800", input_cache_read: "0.0000000220" },
		},
		{
			id: "deepseek/deepseek-v4.1-flash",
			name: "DeepSeek V4.1 Flash",
			context_length: 1048576,
			supported_endpoint_types: ["openai", "openai-response", "anthropic"],
			architecture: { input_modalities: ["text", "image"] },
			pricing: { prompt: "0.0000001000", completion: "0.0000004000" },
		},
		{
			id: "orcarouter/auto",
			name: "OrcaRouter Auto",
			supported_endpoint_types: ["openai", "openai-response", "anthropic", "gemini"],
		},
		{
			id: "anthropic/claude-opus-4.8",
			supported_endpoint_types: ["anthropic"],
			architecture: { input_modalities: ["text", "image"] },
			pricing: { prompt: "0.000003", completion: "0.000015" },
		},
		{
			id: "google/gemini-3.5-flash",
			supported_endpoint_types: ["gemini"],
			architecture: { input_modalities: ["text", "image"] },
		},
		{
			id: "vendor/embed-1",
			supported_endpoint_types: ["embeddings"],
			architecture: { input_modalities: ["text"] },
		},
		{
			id: "vendor/image-gen-1",
			supported_endpoint_types: ["image-generation"],
		},
		{
			id: "vendor/video-1",
			supported_endpoint_types: ["openai-video"],
		},
		{
			id: "vendor/rerank-1",
			supported_endpoint_types: ["jina-rerank"],
		},
	],
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ids(catalog: readonly OrcaRouterModelRecord[]): string[] {
	return catalog.map((model) => model.id).sort();
}

describe("OrcaRouter capability filtering", () => {
	it("keeps only text-capable chat routes for the text selector", () => {
		const catalog = parseOrcaRouterCatalog(FIXTURE);
		const text = filterOrcaRouterCatalog(catalog, "text");
		expect(ids(text)).toEqual([
			"anthropic/claude-opus-4.8",
			"deepseek/deepseek-v4-pro",
			"deepseek/deepseek-v4.1-flash",
			"google/gemini-3.5-flash",
			"orcarouter/auto",
		]);
		// Media, embedding, and rerank routes never reach the chat selector.
		for (const model of text) {
			expect(isTextChatModel(model)).toBe(true);
			expect(model.endpointTypes).not.toContain("embeddings");
			expect(model.endpointTypes).not.toContain("image-generation");
			expect(model.endpointTypes).not.toContain("openai-video");
			expect(model.endpointTypes).not.toContain("jina-rerank");
		}
	});

	it("fails closed for multimodal: only entries declaring the modality qualify", () => {
		const catalog = parseOrcaRouterCatalog(FIXTURE);
		const imageInput = filterOrcaRouterCatalog(catalog, "text", "image");
		expect(ids(imageInput)).toEqual([
			"anthropic/claude-opus-4.8",
			"deepseek/deepseek-v4.1-flash",
			"google/gemini-3.5-flash",
		]);
		// `deepseek/deepseek-v4-pro` declares text only, and `orcarouter/auto`
		// declares nothing at all: neither may appear in a multimodal selector.
		expect(ids(imageInput)).not.toContain("deepseek/deepseek-v4-pro");
		expect(ids(imageInput)).not.toContain("orcarouter/auto");

		const noDeclaration = catalog.find((model) => model.id === "orcarouter/auto");
		expect(noDeclaration?.inputModalities).toBeUndefined();
		expect(isMultimodalChatModel(noDeclaration as OrcaRouterModelRecord, "image")).toBe(false);
	});

	it("separates embedding, image generation, video, and rerank strictly", () => {
		const catalog = parseOrcaRouterCatalog(FIXTURE);
		expect(ids(filterOrcaRouterCatalog(catalog, "embedding"))).toEqual(["vendor/embed-1"]);
		expect(ids(filterOrcaRouterCatalog(catalog, "image"))).toEqual(["vendor/image-gen-1"]);
		expect(ids(filterOrcaRouterCatalog(catalog, "video"))).toEqual(["vendor/video-1"]);
		expect(ids(filterOrcaRouterCatalog(catalog, "rerank"))).toEqual(["vendor/rerank-1"]);

		const embed = catalog.find((model) => model.id === "vendor/embed-1") as OrcaRouterModelRecord;
		expect(isEmbeddingModel(embed)).toBe(true);
		expect(isTextChatModel(embed)).toBe(false);
		expect(isImageGenerationModel(embed)).toBe(false);
		expect(isVideoModel(embed)).toBe(false);
		expect(isRerankModel(embed)).toBe(false);
	});

	it("maps each capability onto its documented query value", () => {
		expect(capabilityQueryValue("text")).toBe("chat");
		expect(capabilityQueryValue("chat")).toBe("chat");
		expect(capabilityQueryValue("image-input")).toBe("chat");
		expect(capabilityQueryValue("embedding")).toBe("embedding");
		expect(capabilityQueryValue("image")).toBe("image");
		expect(capabilityQueryValue("video")).toBe("video");
		expect(capabilityQueryValue("rerank")).toBe("rerank");
	});

	it("preserves vendor/model ids and per-token pricing as per-million cost", () => {
		const catalog = parseOrcaRouterCatalog(FIXTURE);
		const pro = catalog.find((model) => model.id === "deepseek/deepseek-v4-pro");
		expect(pro?.id).toBe("deepseek/deepseek-v4-pro");
		expect(pro?.cost.input).toBeCloseTo(0.66, 6);
		expect(pro?.cost.output).toBeCloseTo(1.98, 6);
		expect(pro?.cost.cacheRead).toBeCloseTo(0.022, 6);
		expect(pro?.contextLength).toBe(1048576);
		expect(pro?.maxCompletionTokens).toBe(384000);
	});

	it("tolerates a bare array envelope, junk entries, and an absent catalog", () => {
		expect(parseOrcaRouterCatalog([])).toEqual([]);
		expect(parseOrcaRouterCatalog({})).toEqual([]);
		expect(parseOrcaRouterCatalog({ data: "nope" })).toEqual([]);
		expect(parseOrcaRouterCatalog({ data: [null, 4, {}, { id: "" }, { id: "ok/one" }] })).toHaveLength(1);
		expect(parseOrcaRouterCatalog([{ id: "bare/array" }])).toHaveLength(1);
	});
});

describe("OrcaRouter model discovery", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("reads the live catalog from the inference origin with the user's bearer key", async () => {
		let seenUrl: string | undefined;
		let seenAuth: string | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				seenUrl = String(input);
				seenAuth = new Headers(init?.headers).get("authorization") ?? undefined;
				return jsonResponse(FIXTURE);
			}),
		);

		const catalog = await fetchOrcaRouterCatalog({ baseUrl: ORIGIN, apiKey: "sk-orca-live", capability: "chat" });
		expect(catalog.length).toBe(9);

		const url = new URL(String(seenUrl));
		expect(url.origin).toBe("https://api.orcarouter.ai");
		expect(url.pathname).toBe("/v1/models");
		expect(url.searchParams.get("capability")).toBe("chat");
		expect(seenAuth).toBe("Bearer sk-orca-live");
	});

	it("defaults the inference origin to the documented /v1 base and honours overrides", () => {
		expect(ORCAROUTER_DEFAULT_API_BASE_URL).toBe("https://api.orcarouter.ai/v1");
		vi.stubEnv("ORCA_BASE_URL", "https://gateway.internal.example");
		expect(resolveOrcaRouterApiBaseUrl()).toBe("https://gateway.internal.example/v1");
		vi.stubEnv("ORCA_API_BASE_URL", "https://relay.internal.example/v2");
		expect(resolveOrcaRouterApiBaseUrl()).toBe("https://relay.internal.example/v2");
		vi.unstubAllEnvs();
		expect(resolveOrcaRouterApiBaseUrl()).toBe("https://api.orcarouter.ai/v1");
	});

	it("selects a native pi API for each vendor surface", () => {
		const catalog = parseOrcaRouterCatalog(FIXTURE);
		const api = (id: string) => {
			const record = catalog.find((model) => model.id === id) as OrcaRouterModelRecord;
			return selectOrcaRouterApi(record);
		};
		expect(api("anthropic/claude-opus-4.8")).toBe("anthropic-messages");
		expect(api("google/gemini-3.5-flash")).toBe("google-generative-ai");
		expect(api("deepseek/deepseek-v4-pro")).toBe("openai-completions");
		expect(api("vendor/embed-1")).toBeUndefined();
		expect(api("vendor/image-gen-1")).toBeUndefined();
	});

	it("converts catalog records into pi models with the OrcaRouter base URL", () => {
		const catalog = parseOrcaRouterCatalog(FIXTURE);
		const models = toOrcaRouterModels(filterOrcaRouterCatalog(catalog, "text"), {
			providerId: "orcarouter",
			baseUrl: ORIGIN,
		});
		expect(models.map((model) => model.id)).toContain("deepseek/deepseek-v4-pro");
		for (const model of models) {
			expect(model.provider).toBe("orcarouter");
			expect(model.baseUrl).toBe("https://api.orcarouter.ai/v1");
		}
		const flash = models.find((model) => model.id === "deepseek/deepseek-v4.1-flash");
		expect(flash?.input).toEqual(["text", "image"]);
		const pro = models.find((model) => model.id === "deepseek/deepseek-v4-pro");
		expect(pro?.input).toEqual(["text"]);
	});

	it("retains verified seed metadata instead of erasing it with absent catalog fields", () => {
		// A live entry for a seeded model that omits context/modalities/reasoning.
		const sparse = parseOrcaRouterCatalog({
			data: [
				{
					id: "openai/gpt-5.5",
					supported_endpoint_types: ["openai", "openai-response"],
				},
			],
		});
		const [model] = toOrcaRouterModels(sparse, { providerId: "orcarouter", baseUrl: ORIGIN });
		expect(model?.reasoning).toBe(true);
		expect(model?.thinkingLevelMap).toMatchObject({ low: "low", medium: "medium", high: "high", xhigh: "xhigh" });
		expect(model?.input).toContain("image");
		expect(model?.contextWindow).toBeGreaterThan(0);
	});

	it("bounds the catalog response size", async () => {
		const huge = "x".repeat(ORCAROUTER_CATALOG_MAX_BYTES + 1024);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(huge, { status: 200, headers: { "content-type": "application/json" } })),
		);
		await expect(fetchOrcaRouterCatalog({ baseUrl: ORIGIN, capability: "chat" })).rejects.toThrow(/size limit/);
	});

	it("surfaces HTTP and transport failures so the caller can keep its previous catalog", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "nope" }, 500)),
		);
		await expect(fetchOrcaRouterCatalog({ baseUrl: ORIGIN, capability: "chat" })).rejects.toThrow(/HTTP 500/);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("dns failure");
			}),
		);
		await expect(fetchOrcaRouterCatalog({ baseUrl: ORIGIN, capability: "chat" })).rejects.toThrow(/dns failure/);
	});

	it("publishes live results and replaces the seed, without mixing the two", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(FIXTURE)),
		);
		const provider = orcaRouterProvider();
		let published: readonly { id: string }[] = [];
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "sk-orca-live" },
			publish: async (publication) => {
				publication.update?.();
				published = publication.persist?.models ?? [];
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		const live = provider.getModels().map((model) => model.id);
		expect(live).toContain("deepseek/deepseek-v4-pro");
		// Live discovery is authoritative: a surviving seed-only id proves mixing.
		// `openai/gpt-5.5` is seeded but absent from the fixture, so it must not
		// appear after a successful live read.
		expect(live).not.toContain("openai/gpt-5.5");
		expect(published.map((model) => model.id)).not.toContain("openai/gpt-5.5");
		expect(live).not.toContain("vendor/embed-1");
		// Exactly the fixture's text chat routes, nothing more.
		expect([...live].sort()).toEqual(
			[
				"anthropic/claude-opus-4.8",
				"deepseek/deepseek-v4-pro",
				"deepseek/deepseek-v4.1-flash",
				"google/gemini-3.5-flash",
				"orcarouter/auto",
			].sort(),
		);
	});

	it("keeps the provider usable from the verified seed when discovery fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("catalog offline");
			}),
		);
		const provider = orcaRouterProvider();
		const before = provider.getModels().map((model) => model.id);
		await expect(
			provider.refreshModels?.({
				publish: async () => true,
				allowNetwork: true,
				signal: new AbortController().signal,
			}),
		).rejects.toThrow(/catalog offline/);

		// The seed survives: a fresh install is never left with no models.
		expect(provider.getModels().map((model) => model.id)).toEqual(before);
		expect(before).toEqual([
			"openai/gpt-5.5",
			"anthropic/claude-opus-4.8",
			"google/gemini-3.5-flash",
			"deepseek/deepseek-v4-pro",
			"orcarouter/auto",
		]);
	});

	it("keeps the last known-good catalog and reports the failure when a later refresh fails", async () => {
		const provider = orcaRouterProvider();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(FIXTURE)),
		);
		await provider.refreshModels?.({
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		const known = provider.getModels().map((model) => model.id);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("catalog offline");
			}),
		);
		// The failure is reported so the UI can show a degraded catalog, while the
		// last known-good list stays in place.
		await expect(
			provider.refreshModels?.({
				stored: { models: provider.getModels(), checkedAt: Date.now() },
				publish: async (publication) => {
					publication.update?.();
					return true;
				},
				allowNetwork: true,
				signal: new AbortController().signal,
			}),
		).rejects.toThrow(/catalog offline/);
		expect(provider.getModels().map((model) => model.id)).toEqual(known);
	});

	it("does not spend a network request when network access is disallowed", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(FIXTURE));
		vi.stubGlobal("fetch", fetchMock);
		const provider = orcaRouterProvider();
		await provider.refreshModels?.({
			publish: async (publication) => {
				if (publication.update) publication.update();
				return true;
			},
			allowNetwork: false,
			signal: new AbortController().signal,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(provider.getModels().map((model) => model.id)).toEqual(ORCAROUTER_FALLBACK_MODELS.map((m) => m.id));
	});

	it("exposes OrcaRouter as a first-class provider beside the other gateways", () => {
		const provider = orcaRouterProvider();
		expect(provider.id).toBe("orcarouter");
		expect(provider.name).toBe("OrcaRouter");
		expect(provider.baseUrl).toBe("https://api.orcarouter.ai/v1");
	});
});
