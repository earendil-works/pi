import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { ollamaCloudProvider } from "../src/providers/ollama-cloud.ts";
import type { Model } from "../src/types.ts";

function cachedModel(): Model<"openai-completions"> {
	return {
		id: "cached",
		name: "cached",
		api: "openai-completions",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

describe("ollamaCloudProvider", () => {
	it("validates login and refreshes the Ollama Cloud catalog", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			if (url.endsWith("/v1/models")) {
				return Response.json({
					data: [{ id: "glm-5.2" }, { id: "minimax-m3" }, { id: "glm-5.2" }],
				});
			}
			return new Response(null, { status: 404 });
		});
		const provider = ollamaCloudProvider({ baseUrl: "https://cloud.example/", fetch: fetchImpl as typeof fetch });
		const credentials = new InMemoryCredentialStore();
		const modelsStore = new InMemoryModelsStore();
		const models = createModels({ credentials, modelsStore });
		models.setProvider(provider);
		const notifications: string[] = [];
		const credential = await models.login("ollama-cloud", "api_key", {
			prompt: async () => "secret-key",
			notify: (event) => {
				if (event.type === "progress") notifications.push(event.message);
			},
		});

		expect(credential).toEqual({ type: "api_key", key: "secret-key" });
		expect(await credentials.read("ollama-cloud")).toEqual(credential);
		expect(notifications).toEqual(["Checking Ollama Cloud API key..."]);
		expect(requests[0]?.url).toBe("https://cloud.example/v1/models");
		expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe("Bearer secret-key");
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["glm-5.2", "minimax-m3"]);

		const result = await models.refresh({ providers: ["ollama-cloud"] });

		expect(result.errors.size).toBe(0);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(requests.map((request) => request.url)).toEqual([
			"https://cloud.example/v1/models",
			"https://cloud.example/v1/models",
		]);
		expect(provider.getModels()).toMatchObject([
			{
				id: "glm-5.2",
				baseUrl: "https://cloud.example/v1",
				contextWindow: 976_000,
				maxTokens: 131_072,
				reasoning: true,
				thinkingLevelMap: { high: "high", max: "max" },
				input: ["text"],
				compat: { supportsReasoningEffort: true },
			},
			{
				id: "minimax-m3",
				contextWindow: 512_000,
				maxTokens: 131_072,
				reasoning: true,
				thinkingLevelMap: { low: "low", medium: "medium", high: "high", max: "max" },
				input: ["text", "image"],
				compat: { supportsReasoningEffort: true },
			},
		]);
		expect((await modelsStore.read("ollama-cloud"))?.models).toHaveLength(2);
	});

	it("rejects an invalid API key before saving it", async () => {
		const credentials = new InMemoryCredentialStore();
		const provider = ollamaCloudProvider({
			fetch: vi.fn(async () => new Response(null, { status: 401 })) as typeof fetch,
		});
		const models = createModels({ credentials });
		models.setProvider(provider);

		await expect(
			models.login("ollama-cloud", "api_key", {
				prompt: async () => "bad-key",
				notify: () => {},
			}),
		).rejects.toThrow("Ollama Cloud rejected the API key");
		expect(await credentials.read("ollama-cloud")).toBeUndefined();
		expect(provider.getModels().map((model) => model.id)).toEqual(["glm-5.2"]);
		expect(provider.getModels()[0]).toMatchObject({
			reasoning: true,
			thinkingLevelMap: { high: "high", max: "max" },
			compat: { supportsReasoningEffort: true },
		});
	});

	it("restores cached models without network access", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("ollama-cloud", async () => ({ type: "api_key", key: "secret-key" }));
		const modelsStore = new InMemoryModelsStore();
		await modelsStore.write("ollama-cloud", { models: [cachedModel()], checkedAt: Date.now() });
		const fetchImpl = vi.fn();
		const provider = ollamaCloudProvider({ fetch: fetchImpl as typeof fetch });
		const models = createModels({ credentials, modelsStore });
		models.setProvider(provider);

		const result = await models.refresh({ allowNetwork: false, providers: ["ollama-cloud"] });

		expect(result.errors.size).toBe(0);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(provider.getModels().map((model) => model.id)).toEqual(["cached"]);
	});

	it("uses conservative metadata for models missing from the generated catalog", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("ollama-cloud", async () => ({ type: "api_key", key: "secret-key" }));
		const fetchImpl = vi.fn(async (input: string | URL | Request) => {
			if (String(input).endsWith("/v1/models")) return Response.json({ data: [{ id: "new-model" }] });
			return new Response(null, { status: 500 });
		});
		const provider = ollamaCloudProvider({ fetch: fetchImpl as typeof fetch });
		const models = createModels({ credentials });
		models.setProvider(provider);

		const result = await models.refresh({ providers: ["ollama-cloud"] });

		expect(result.errors.size).toBe(0);
		expect(provider.getModels()).toMatchObject([
			{
				id: "new-model",
				contextWindow: 128_000,
				maxTokens: 16_384,
				reasoning: false,
				input: ["text"],
			},
		]);
	});

	it("keeps a cached catalog when model discovery fails", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("ollama-cloud", async () => ({ type: "api_key", key: "secret-key" }));
		const modelsStore = new InMemoryModelsStore();
		await modelsStore.write("ollama-cloud", { models: [cachedModel()], checkedAt: 1 });
		const provider = ollamaCloudProvider({
			fetch: vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch,
		});
		const models = createModels({ credentials, modelsStore });
		models.setProvider(provider);
		expect((await models.refresh({ allowNetwork: false })).errors.size).toBe(0);

		const result = await models.refresh({ providers: ["ollama-cloud"] });

		expect(result.errors.get("ollama-cloud")?.message).toBe("Ollama Cloud model request failed: HTTP 503");
		expect(provider.getModels().map((model) => model.id)).toEqual(["cached"]);
		expect((await modelsStore.read("ollama-cloud"))?.models.map((model) => model.id)).toEqual(["cached"]);
	});

	it("does not replace a cached catalog when refresh is cancelled", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("ollama-cloud", async () => ({ type: "api_key", key: "secret-key" }));
		const modelsStore = new InMemoryModelsStore();
		await modelsStore.write("ollama-cloud", { models: [cachedModel()], checkedAt: 1 });
		let markRequestStarted: (() => void) | undefined;
		const requestStarted = new Promise<void>((resolve) => {
			markRequestStarted = resolve;
		});
		const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			markRequestStarted?.();
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return;
				const onAbort = () => reject(signal.reason);
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			});
		});
		const provider = ollamaCloudProvider({ fetch: fetchImpl as typeof fetch });
		const models = createModels({ credentials, modelsStore });
		models.setProvider(provider);
		expect((await models.refresh({ allowNetwork: false })).errors.size).toBe(0);

		const controller = new AbortController();
		const refresh = models.refresh({ providers: ["ollama-cloud"], signal: controller.signal });
		await requestStarted;
		controller.abort();

		expect(await refresh).toMatchObject({ aborted: true });
		expect(provider.getModels().map((model) => model.id)).toEqual(["cached"]);
		expect((await modelsStore.read("ollama-cloud"))?.models.map((model) => model.id)).toEqual(["cached"]);
	});
});
