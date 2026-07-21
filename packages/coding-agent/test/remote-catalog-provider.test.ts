import { createProvider, InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
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
		const provider = withRemoteCatalog(
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
		);
		const store = new InMemoryModelsStore();
		await provider.refreshModels?.({
			credential: { type: "api_key" },
			store: {
				read: () => store.read(provider.id),
				write: (entry) => store.write(provider.id, entry),
				delete: () => store.delete(provider.id),
			},
			allowNetwork: true,
		});
		await provider.refreshModels?.({
			credential: { type: "api_key" },
			store: {
				read: () => store.read(provider.id),
				write: (entry) => store.write(provider.id, entry),
				delete: () => store.delete(provider.id),
			},
			allowNetwork: true,
		});
		await provider.refreshModels?.({
			credential: { type: "api_key" },
			store: {
				read: () => store.read(provider.id),
				write: (entry) => store.write(provider.id, entry),
				delete: () => store.delete(provider.id),
			},
			allowNetwork: true,
			force: true,
		});

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
			"User-Agent": expect.stringContaining(`pi/${VERSION}`),
		});
	});

	it("treats unimplemented pi.dev catalog routes as an unavailable overlay", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not implemented", { status: 501 }));
		const provider = withRemoteCatalog(
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
		);
		const store = new InMemoryModelsStore();

		await expect(
			provider.refreshModels?.({
				credential: { type: "api_key" },
				store: {
					read: () => store.read(provider.id),
					write: (entry) => store.write(provider.id, entry),
					delete: () => store.delete(provider.id),
				},
				allowNetwork: true,
			}),
		).resolves.toBeUndefined();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);
		expect(await store.read(provider.id)).toMatchObject({ models: [], checkedAt: expect.any(Number) });
	});
});
