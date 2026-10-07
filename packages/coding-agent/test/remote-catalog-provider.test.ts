import {
	createModels,
	createProvider,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { REMOTE_CATALOG_MODEL_TYPES, withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

const neverAbortedSignal = new AbortController().signal;

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

function testProvider(localGeneratedAt?: number, refreshModels?: Provider["refreshModels"]) {
	return withRemoteCatalog(
		{
			...createProvider({
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
			refreshModels,
		},
		"https://pi.dev",
		localGeneratedAt,
	);
}

async function refreshProvider(
	provider: Provider,
	store: InMemoryModelsStore,
	overrides: Partial<Pick<RefreshModelsContext, "allowNetwork" | "force" | "signal">> = {},
): Promise<void> {
	const publish = async (publication: ModelsPublication): Promise<boolean> => {
		if (publication.persist === null) await store.delete(provider.id);
		else if (publication.persist !== undefined) await store.write(provider.id, publication.persist);
		publication.update?.();
		return true;
	};
	await provider.refreshModels?.({
		credential: { type: "api_key" },
		stored: await store.read(provider.id),
		publish,
		allowNetwork: overrides.allowNetwork ?? true,
		force: overrides.force,
		signal: overrides.signal ?? neverAbortedSignal,
	});
}

afterEach(() => vi.restoreAllMocks());

describe("remote catalog provider", () => {
	// #10353: Public catalog overlays must preserve credential-scoped provider discovery.
	it.each([
		{ name: "a fresh cached catalog", status: undefined },
		{ name: "an unchanged catalog", status: 304 },
		{ name: "a missing catalog", status: 404 },
		{ name: "an unimplemented catalog", status: 501 },
	])("refreshes native availability with $name", async ({ status }) => {
		const nativeRefresh = vi.fn(async (context: RefreshModelsContext) => {
			await context.publish({ update: () => {} });
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status }));
		const provider = testProvider(undefined, nativeRefresh);
		const store = new InMemoryModelsStore();
		await store.write(provider.id, {
			models: [model("cached")],
			checkedAt: status === undefined ? Date.now() : 0,
			lastModified: 1,
			etag: '"catalog-1"',
		});

		await refreshProvider(provider, store);

		expect(nativeRefresh).toHaveBeenCalledOnce();
		expect(nativeRefresh.mock.calls[0]?.[0]).toMatchObject({
			credential: { type: "api_key" },
			allowNetwork: true,
			signal: neverAbortedSignal,
		});
		expect(fetchSpy).toHaveBeenCalledTimes(status === undefined ? 0 : 1);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["cached"]);
	});

	// #10353: Authenticated availability is private state, not persistent catalog metadata.
	it("publishes native availability separately from public catalog metadata", async () => {
		let allowedIds: ReadonlySet<string> = new Set();
		const nativeRefresh = vi.fn(async (context: RefreshModelsContext) => {
			await context.publish({
				update: () => {
					allowedIds = new Set(["dynamic"]);
				},
			});
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([model("dynamic")])));
		const provider = testProvider(undefined, nativeRefresh);
		provider.filterModels = (entries) => entries.filter((entry) => allowedIds.has(entry.id));
		const store = new InMemoryModelsStore();
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);

		await refreshProvider(provider, store);

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect((await models.getAvailable()).map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(await store.read(provider.id)).toMatchObject({ models: [model("dynamic")] });
	});

	// #10353: Either refresh source must finish even when the other source fails.
	it("refreshes catalog metadata when native discovery fails", async () => {
		const discoveryError = new Error("Authenticated discovery failed");
		const provider = testProvider(undefined, () => {
			throw discoveryError;
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([model("dynamic")])));
		const store = new InMemoryModelsStore();

		await expect(refreshProvider(provider, store)).rejects.toBe(discoveryError);

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
	});

	// #10353: A catalog failure must not suppress authenticated provider discovery.
	it("publishes native availability when catalog metadata fails", async () => {
		let nativePublished = false;
		const provider = testProvider(undefined, async (context) => {
			await context.publish({
				update: () => {
					nativePublished = true;
				},
			});
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 403 }));
		const store = new InMemoryModelsStore();

		await expect(refreshProvider(provider, store)).rejects.toThrow(
			"Model catalog request failed for test-provider: 403",
		);

		expect(nativePublished).toBe(true);
		expect((await store.read(provider.id))?.models).toEqual([]);
	});

	// #10353: Callers need both failure messages when discovery and catalog refresh fail.
	it("reports native and catalog refresh failures together", async () => {
		const provider = testProvider(undefined, async () => {
			throw new Error("Authenticated discovery failed");
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 403 }));

		await expect(refreshProvider(provider, new InMemoryModelsStore())).rejects.toThrow(
			"Authenticated discovery failed; Model catalog request failed for test-provider: 403",
		);
	});

	// #10353: Offline initialization still calls the native hook without authorizing network access.
	it("restores catalog metadata and native state while offline", async () => {
		const nativeRefresh = vi.fn(async (_context: RefreshModelsContext) => {});
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const provider = testProvider(undefined, nativeRefresh);
		const store = new InMemoryModelsStore();
		await store.write(provider.id, { models: [model("cached")] });

		await refreshProvider(provider, store, { allowNetwork: false });

		expect(nativeRefresh).toHaveBeenCalledOnce();
		expect(nativeRefresh.mock.calls[0]?.[0]).toMatchObject({ allowNetwork: false });
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "cached"]);
	});

	// #10353: A rejected catalog publication must not skip the native refresh hook.
	it("calls native discovery when the catalog publication is rejected", async () => {
		const nativeRefresh = vi.fn(async () => {});
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const provider = testProvider(undefined, nativeRefresh);
		await provider.refreshModels?.({
			publish: async () => false,
			allowNetwork: true,
			signal: neverAbortedSignal,
		});

		expect(nativeRefresh).toHaveBeenCalledOnce();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

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
		await refreshProvider(provider, store);
		await refreshProvider(provider, store);
		await refreshProvider(provider, store, { force: true });

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
			"User-Agent": expect.stringContaining(`pi/${VERSION}`),
		});
		const requested = new URL(String(fetchSpy.mock.calls[0]?.[0]));
		expect(requested.pathname).toBe("/api/models/providers/test-provider");
		expect(requested.searchParams.get("types")).toBe(REMOTE_CATALOG_MODEL_TYPES.join(","));
	});

	it("overlays image and classifier models and drops unknown model types", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						chat: { ...model("chat"), type: "chat" },
						flux: {
							type: "image",
							id: "flux",
							name: "FLUX",
							api: "openrouter-images",
							provider: "test-provider",
							baseUrl: "https://example.test/v1",
							input: ["text"],
							output: ["image"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
						jev: {
							type: "classifier",
							id: "jev",
							name: "Jev",
							api: "typesafe-system-one",
							provider: "test-provider",
							baseUrl: "https://example.test/v1",
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 64000,
						},
						clip: { ...model("clip"), type: "video" },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);

		const models = createModels({ modelsStore: store });
		models.setProvider(provider);
		expect(models.getAllModels("test-provider").map((entry) => entry.id)).toEqual(["static", "chat", "flux", "jev"]);
		expect(models.getModelOfType("image", "test-provider", "flux")?.type).toBe("image");
		expect(models.getModelOfType("classifier", "test-provider", "jev")?.type).toBe("classifier");
		expect(models.getModel("test-provider", "flux")).toBeUndefined();
		const stored = await store.read(provider.id);
		expect(stored?.models.map((entry) => entry.id)).toEqual(["chat", "flux", "jev"]);
	});

	it("prefers the newer of the generated and remote catalogs", async () => {
		const localGeneratedAt = Date.parse("2026-07-23T10:00:00.000Z");
		const newerHeader = new Date(localGeneratedAt + 60_000).toUTCString();
		const responses = [
			new Response(JSON.stringify({ old: model("old") }), {
				headers: { "last-modified": new Date(localGeneratedAt - 60_000).toUTCString() },
			}),
			new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "last-modified": newerHeader },
			}),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider(localGeneratedAt);
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);

		await refreshProvider(provider, store, { force: true });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect(await store.read(provider.id)).toMatchObject({ lastModified: Date.parse(newerHeader) });
	});

	it("revalidates a stored catalog with its etag and keeps the overlay on 304", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match");
		expect(await store.read(provider.id)).toMatchObject({ etag: '"catalog-1"' });

		const checkedAt = (await store.read(provider.id))?.checkedAt;
		await refreshProvider(provider, store, { force: true });

		expect(fetchSpy.mock.calls[1]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		const stored = await store.read(provider.id);
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.checkedAt).toBeGreaterThanOrEqual(checkedAt ?? 0);
	});

	it("drops a stale etag when the overlay becomes unavailable", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("not implemented", { status: 501 }),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		await refreshProvider(provider, store, { force: true });

		expect((await store.read(provider.id))?.etag).toBeUndefined();
	});

	it("keeps the etag and overlay after a transient failure", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		await expect(refreshProvider(provider, store, { force: true })).rejects.toThrow(/429/);

		const stored = await store.read(provider.id);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);

		await refreshProvider(provider, store, { force: true });
		expect(fetchSpy.mock.calls[4]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
	});

	it("lets a newer catalog request bypass a stalled older request without stale publication", async () => {
		let calls = 0;
		let markFirstStarted: (() => void) | undefined;
		let finishFirst: ((response: Response) => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstResponse = new Promise<Response>((resolve) => {
			finishFirst = resolve;
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			calls++;
			if (calls === 1) {
				markFirstStarted?.();
				return firstResponse;
			}
			return new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "content-type": "application/json" },
			});
		});
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);

		const first = models.refresh({ providers: [provider.id], force: true });
		await firstStarted;
		const second = models.refresh({ providers: [provider.id], force: true });
		await second;
		await first;
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);

		finishFirst?.(
			new Response(JSON.stringify({ older: model("older") }), {
				headers: { "content-type": "application/json" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["newer"]);
	});

	it("treats unimplemented pi.dev catalog routes as an unavailable overlay", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not implemented", { status: 501 }));
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await expect(refreshProvider(provider, store)).resolves.toBeUndefined();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);
		expect(await store.read(provider.id)).toMatchObject({ models: [], checkedAt: expect.any(Number) });
	});
});
