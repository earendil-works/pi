import { statSync } from "node:fs";
import {
	createProvider,
	InMemoryModelsStore,
	type Model,
	type ModelsStoreEntry,
	type ProviderModelsStore,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function testProvider(localCatalogUrl?: URL) {
	return withRemoteCatalog(
		createProvider({
			id: "test-provider",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model("static")],
			api: {
				stream: () => {
					throw new Error("not used");
				},
				streamSimple: () => {
					throw new Error("not used");
				},
			},
		}),
		"https://pi.dev",
		localCatalogUrl,
	);
}

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
	return {
		read: () => store.read("test-provider"),
		write: (entry: ModelsStoreEntry) => store.write("test-provider", entry),
		delete: () => store.delete("test-provider"),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("remote catalog provider", () => {
	it("parses keyed catalogs, sends version headers, observes the refresh TTL, and supports forced refreshes", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ dynamic: model("dynamic") }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		const refresh = { credential: { type: "api_key" } as const, store: scopedStore(store), allowNetwork: true };
		await provider.refreshModels?.(refresh);
		await provider.refreshModels?.(refresh);
		await provider.refreshModels?.({ ...refresh, force: true });

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
			"User-Agent": expect.stringContaining(`pi/${VERSION}`),
		});
	});

	it("prefers the newer of the generated and remote catalogs", async () => {
		const localCatalogUrl = new URL(import.meta.url);
		const localMtime = statSync(localCatalogUrl).mtimeMs;
		const newerHeader = new Date(localMtime + 60_000).toUTCString();
		const responses = [
			new Response(JSON.stringify({ old: model("old") }), {
				headers: { "last-modified": new Date(localMtime - 60_000).toUTCString() },
			}),
			new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "last-modified": newerHeader },
			}),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider(localCatalogUrl);
		const store = new InMemoryModelsStore();
		const refresh = { credential: { type: "api_key" } as const, store: scopedStore(store), allowNetwork: true };

		await provider.refreshModels?.(refresh);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);

		await provider.refreshModels?.({ ...refresh, force: true });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect(await store.read(provider.id)).toMatchObject({ lastModified: Date.parse(newerHeader) });
	});

	it("treats unimplemented pi.dev catalog routes as an unavailable overlay", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not implemented", { status: 501 }));
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await expect(
			provider.refreshModels?.({
				credential: { type: "api_key" },
				store: scopedStore(store),
				allowNetwork: true,
			}),
		).resolves.toBeUndefined();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);
		expect(await store.read(provider.id)).toMatchObject({ models: [], checkedAt: expect.any(Number) });
	});
});
