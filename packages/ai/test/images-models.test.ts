import { describe, expect, it } from "vitest";
import type { AuthContext } from "../src/auth/types.ts";
import { createImagesModels, createImagesProvider, type ImagesProvider } from "../src/images-models.ts";
import { builtinImagesModels } from "../src/providers/all.ts";
import type { AssistantImages, ImagesApi, ImagesContext, ImagesModel, ImagesOptions } from "../src/types.ts";

function fakeAuthContext(env: Record<string, string>): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async () => false,
	};
}

function testImageModel(provider: string, id: string): ImagesModel<ImagesApi> {
	return {
		id,
		name: id,
		api: "test-images",
		provider,
		baseUrl: "https://example.test/v1",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function okResult(model: ImagesModel<ImagesApi>): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface GenerateCall {
	model: ImagesModel<ImagesApi>;
	options: ImagesOptions | undefined;
}

function testProvider(input: {
	id: string;
	models?: ImagesModel<ImagesApi>[];
	envVar?: string;
	calls?: GenerateCall[];
}): ImagesProvider {
	return createImagesProvider({
		id: input.id,
		auth: {
			apiKey: {
				name: "Test key",
				resolve: async ({ ctx, credential }) => {
					if (!input.envVar) return { auth: {} };
					const key = credential?.key ?? (await ctx.env(input.envVar));
					return key ? { auth: { apiKey: key }, source: credential ? "stored" : input.envVar } : undefined;
				},
			},
		},
		models: input.models ?? [testImageModel(input.id, "model-a")],
		api: {
			generateImages: async (model, _context, options) => {
				input.calls?.push({ model, options });
				return okResult(model);
			},
		},
	});
}

const context: ImagesContext = { input: [{ type: "text", text: "a red circle" }] };

describe("ImagesModels", () => {
	it("registers providers and reads models synchronously", () => {
		const models = createImagesModels();
		models.setProvider(testProvider({ id: "p1", models: [testImageModel("p1", "m1"), testImageModel("p1", "m2")] }));
		models.setProvider(testProvider({ id: "p2", models: [testImageModel("p2", "m3")] }));

		expect(models.getProviders().map((p) => p.id)).toEqual(["p1", "p2"]);
		expect(models.getModels().map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
		expect(models.getModels("p1").map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(models.getModel("p2", "m3")?.id).toBe("m3");
		expect(models.getModel("p2", "missing")).toBeUndefined();

		models.deleteProvider("p1");
		expect(models.getProvider("p1")).toBeUndefined();
	});

	it("resolves auth through the provider and merges it into requests; explicit options win", async () => {
		const calls: GenerateCall[] = [];
		const models = createImagesModels({ authContext: fakeAuthContext({ TEST_KEY: "env-key" }) });
		models.setProvider(testProvider({ id: "p1", envVar: "TEST_KEY", calls }));
		const model = models.getModel("p1", "model-a")!;

		expect((await models.getAuth(model))?.auth.apiKey).toBe("env-key");
		expect((await models.getAuth(model.provider))?.auth.apiKey).toBe("env-key");
		expect((await models.getAuth(model, { apiKey: "explicit-key" }))?.auth.apiKey).toBe("explicit-key");

		const result = await models.generateImages(model, context);
		expect(result.stopReason).toBe("stop");
		expect(calls[0].options?.apiKey).toBe("env-key");

		await models.generateImages(model, context, { apiKey: "explicit" });
		expect(calls[1].options?.apiKey).toBe("explicit");
	});

	it("merges provider-resolved env into image options", async () => {
		const calls: GenerateCall[] = [];
		const models = createImagesModels();
		models.setProvider(
			createImagesProvider({
				id: "p1",
				auth: {
					apiKey: {
						name: "Test key",
						resolve: async () => ({
							auth: { apiKey: "provider-key" },
							env: { PROVIDER_ONLY: "provider", SHARED: "provider" },
						}),
					},
				},
				models: [testImageModel("p1", "model-a")],
				api: {
					generateImages: async (model, _context, options) => {
						calls.push({ model, options });
						return okResult(model);
					},
				},
			}),
		);
		const model = models.getModel("p1", "model-a")!;

		await models.generateImages(model, context, {
			apiKey: "request-key",
			env: { REQUEST_ONLY: "request", SHARED: "request" },
		});

		expect(calls[0].options?.apiKey).toBe("request-key");
		expect(calls[0].options?.env).toEqual({
			PROVIDER_ONLY: "provider",
			REQUEST_ONLY: "request",
			SHARED: "request",
		});
	});

	it("returns an error result for unknown providers and unconfigured auth rejections", async () => {
		const models = createImagesModels({ authContext: fakeAuthContext({}) });
		const ghost = await models.generateImages(testImageModel("ghost", "m"), context);
		expect(ghost.stopReason).toBe("error");
		expect(ghost.errorMessage).toContain("Unknown provider: ghost");

		// unconfigured (resolve -> undefined) still dispatches; provider decides what to do
		const calls: GenerateCall[] = [];
		models.setProvider(testProvider({ id: "p1", envVar: "MISSING", calls }));
		const model = models.getModel("p1", "model-a")!;
		expect(await models.getAuth(model)).toBeUndefined();
		await models.generateImages(model, context);
		expect(calls[0].options?.apiKey).toBeUndefined();
	});

	it("supports dynamic providers via refresh with in-flight dedupe", async () => {
		let fetches = 0;
		const provider = createImagesProvider({
			id: "dyn",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [],
			refreshModels: async () => {
				fetches++;
				await new Promise((resolve) => setTimeout(resolve, 5));
				return [testImageModel("dyn", "listed")];
			},
			api: { generateImages: async (model) => okResult(model) },
		});
		const models = createImagesModels();
		models.setProvider(provider);

		expect(models.getModels("dyn")).toEqual([]);
		await Promise.all([models.refresh("dyn"), models.refresh("dyn")]);
		expect(fetches).toBe(1);
		expect(models.getModel("dyn", "listed")).toBeDefined();

		// failures reject with ModelsError for a single provider
		models.setProvider(
			createImagesProvider({
				id: "flaky",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [],
				refreshModels: async () => {
					throw new Error("fetch failed");
				},
				api: { generateImages: async (model) => okResult(model) },
			}),
		);
		await expect(models.refresh("flaky")).rejects.toMatchObject({ code: "model_source" });
		await expect(models.refresh()).resolves.toBeUndefined();
	});

	it("builtinImagesModels registers the openrouter provider with its catalog", async () => {
		const models = builtinImagesModels({ authContext: fakeAuthContext({ OPENROUTER_API_KEY: "or-key" }) });
		const providers = models.getProviders();
		expect(providers.map((p) => p.id)).toEqual(["openrouter"]);

		const list = models.getModels("openrouter");
		expect(list.length).toBeGreaterThan(0);
		expect(list.every((m) => m.api === "openrouter-images")).toBe(true);

		expect((await models.getAuth(list[0]))?.auth.apiKey).toBe("or-key");
	});
});
