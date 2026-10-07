import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { openrouterProvider } from "../src/providers/openrouter.ts";

afterEach(() => vi.unstubAllGlobals());

function setup(key: string | undefined = "workspace-a") {
	const provider = openrouterProvider();
	const networkRefreshes: Promise<void>[] = [];
	const refreshModels = provider.refreshModels!;
	provider.refreshModels = (context) => {
		const refreshing = refreshModels(context);
		if (context.allowNetwork) networkRefreshes.push(refreshing);
		return refreshing;
	};
	const credentials = new InMemoryCredentialStore();
	const store = new InMemoryModelsStore();
	const env: { key: string | undefined } = { key };
	const models = createModels({
		credentials,
		modelsStore: store,
		authContext: { env: async () => env.key, fileExists: async () => false },
	});
	models.setProvider(provider);
	const catalog = provider.getModels();
	const [first, second] = catalog;
	return { provider, credentials, store, env, models, catalog, first, second, networkRefreshes };
}

function response(ids: readonly string[]): Response {
	return Response.json({ data: ids.map((id) => ({ id })) });
}

// #10353: availability follows the OpenRouter key's /models/user list once it is known.
describe("OpenRouter authenticated models", () => {
	it("shows the full catalog until discovery succeeds, then only discovered catalog models", async () => {
		const { models, store, catalog, first } = setup();
		const fetch = vi.fn().mockResolvedValue(response([first.id, "unknown/model"]));
		vi.stubGlobal("fetch", fetch);
		expect(await models.getAvailable()).toEqual(catalog);
		await models.refresh({ allowNetwork: false });
		expect(fetch).not.toHaveBeenCalled();
		expect((await models.refresh()).errors.size).toBe(0);
		expect(fetch.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/models/user");
		expect(new Headers(fetch.mock.calls[0][1].headers).get("authorization")).toBe("Bearer workspace-a");
		expect(await models.getAvailable()).toEqual([first]);
		expect(await store.read("openrouter")).toBeUndefined();
	});

	it("keeps the last verified list on failure and accepts a successful empty response", async () => {
		const { models, first } = setup();
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(response([first.id]))
				.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
				.mockResolvedValueOnce(response([])),
		);
		await models.refresh();
		expect((await models.refresh()).errors.get("openrouter")?.message).toContain("503");
		expect(await models.getAvailable()).toEqual([first]);
		await models.refresh();
		expect(await models.getAvailable()).toEqual([]);
	});

	it("skips malformed entries and rejects a malformed body without filtering", async () => {
		const { models, catalog, first } = setup();
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(Response.json({ data: null }))
				.mockResolvedValueOnce(Response.json({ data: [{}, { id: 123 }, null, { id: first.id }] })),
		);
		expect((await models.refresh()).errors.get("openrouter")?.message).toContain("Invalid");
		expect(await models.getAvailable()).toEqual(catalog);
		expect((await models.refresh()).errors.size).toBe(0);
		expect(await models.getAvailable()).toEqual([first]);
	});

	it("shows the full catalog for a different stored key until it is discovered", async () => {
		const { models, credentials, catalog, first, second } = setup();
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(response([first.id]))
				.mockResolvedValueOnce(response([second.id])),
		);
		await models.refresh();
		await credentials.modify("openrouter", async () => ({
			type: "oauth",
			access: "oauth-workspace",
			refresh: "",
			expires: Number.MAX_SAFE_INTEGER,
		}));
		expect(await models.getAvailable()).toEqual(catalog);
		await models.refresh();
		expect(await models.getAvailable()).toEqual([second]);
	});

	// #10353: A stale credential must not discard the current key's verified model list.
	it("filtering with another credential does not change the verified list", async () => {
		const { models, provider, first } = setup();
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response([first.id])));
		await models.refresh();
		provider.filterModels!(provider.getModels(), { type: "api_key", key: "stale-key" });
		expect(await models.getAvailable()).toEqual([first]);
	});

	it("does not let a superseded request overwrite a newer result", async () => {
		const { models, first, second, networkRefreshes } = setup();
		const started = Promise.withResolvers<void>();
		const pending = Promise.withResolvers<Response>();
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockImplementationOnce(() => {
					started.resolve();
					return pending.promise;
				})
				.mockResolvedValue(response([second.id])),
		);
		const oldRefresh = models.refresh();
		await started.promise;
		await models.refresh();
		await oldRefresh;
		pending.resolve(response([first.id]));
		await Promise.allSettled(networkRefreshes);
		expect(await models.getAvailable()).toEqual([second]);
	});

	// #10353: Request overrides must not redirect account discovery or forward gateway headers.
	it("discovers from OpenRouter with the resolved key and keeps non-chat models", async () => {
		const { models, provider, first } = setup();
		const fetch = vi.fn().mockResolvedValue(response([first.id]));
		vi.stubGlobal("fetch", fetch);
		models.setProvider({
			...provider,
			baseUrl: "https://proxy.example/api/v1/",
			headers: { authorization: "Bearer stale-key", "x-provider": "proxy", "x-removed": null },
			auth: {
				...provider.auth,
				apiKey: {
					...provider.auth.apiKey!,
					resolve: async () => ({
						auth: {
							apiKey: "workspace-resolved",
							headers: { "x-gateway-token": "gw" },
							baseUrl: "https://gateway.example/api/v1",
						},
					}),
				},
			},
		});
		expect((await models.refresh()).errors.size).toBe(0);
		const request = new Request(fetch.mock.calls[0][0], fetch.mock.calls[0][1]);
		expect(request.url).toBe("https://openrouter.ai/api/v1/models/user");
		expect(request.headers.get("authorization")).toBe("Bearer workspace-resolved");
		expect(request.headers.has("x-provider")).toBe(false);
		expect(request.headers.has("x-gateway-token")).toBe(false);
		expect(request.headers.has("x-removed")).toBe(false);
		expect(await models.getAvailable()).toEqual([first]);
		const otherModels = provider.getAllModels!().filter(
			(model) => model.type === "image" || model.type === "classifier",
		);
		expect(await models.getAllAvailable()).toEqual(expect.arrayContaining(otherModels));
	});
});
