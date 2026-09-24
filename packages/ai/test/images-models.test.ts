import { describe, expect, it } from "vitest";
import type { AuthContext } from "../src/auth/types.ts";
import { getModels as getCompatModels } from "../src/compat.ts";
import {
	type CreateProviderOptions,
	createModels,
	createProvider,
	getModelType,
	hasApi,
	isModelType,
	type Provider,
} from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import {
	builtinModels,
	getAllBuiltinModels,
	getBuiltinClassifierModels,
	getBuiltinImageModel,
	getBuiltinImageModels,
	getBuiltinModels,
} from "../src/providers/all.ts";
import type {
	AnyModel,
	Api,
	AssistantImages,
	ImageApi,
	ImageModel,
	ImagesContext,
	ImagesOptions,
	Model,
} from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function fakeAuthContext(env: Record<string, string>): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async () => false,
	};
}

function imageModel(provider: string, id: string): ImageModel<ImageApi> {
	return {
		type: "image",
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

function chatModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "test-chat",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function okResult(model: ImageModel<ImageApi>): AssistantImages {
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
	model: ImageModel<ImageApi>;
	options: ImagesOptions | undefined;
}

function testProvider(input: {
	id: string;
	models?: AnyModel[];
	envVar?: string;
	calls?: GenerateCall[];
	images?: Record<string, boolean>;
}): Provider {
	const generateImages = async (model: ImageModel<ImageApi>, _context: ImagesContext, options?: ImagesOptions) => {
		input.calls?.push({ model, options });
		return okResult(model);
	};
	const imageApis = Object.keys(input.images ?? { "test-images": true });
	const allModels = input.models ?? [imageModel(input.id, "model-a")];
	return createProvider({
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
		models: allModels,
		api: {
			"test-chat": {
				stream: () => new AssistantMessageEventStream(),
				streamSimple: () => new AssistantMessageEventStream(),
			},
		},
		images: Object.fromEntries(imageApis.map((api) => [api, { generateImages }])),
	});
}

const context: ImagesContext = { input: [{ type: "text", text: "a red circle" }] };

describe("model discriminants", () => {
	it("treats models without a type as chat models", () => {
		const chat = chatModel("p", "c");
		const image = imageModel("p", "i");

		expect(chat.type).toBeUndefined();
		expect(getModelType(chat)).toBe("chat");
		expect(getModelType({ ...chat, type: "chat" })).toBe("chat");
		expect(getModelType(image)).toBe("image");
		expect(isModelType(chat, "chat")).toBe(true);
		expect(isModelType(chat, "image")).toBe(false);
		expect(isModelType(image, "image")).toBe(true);

		// hasApi never matches an image model, even on an equal api string
		expect(hasApi({ ...image, api: "test-chat" }, "test-chat")).toBe(false);
		expect(hasApi(chat, "test-chat")).toBe(true);
	});
});

describe("Models with image models", () => {
	it("lists models without a type as chat models at createProvider boundaries", async () => {
		const provider = createProvider({
			id: "legacy",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [chatModel("legacy", "static"), imageModel("legacy", "static")],
			fetchModels: async () => [chatModel("legacy", "dynamic")],
			api: {
				stream: () => new AssistantMessageEventStream(),
				streamSimple: () => new AssistantMessageEventStream(),
			},
		});
		const models = createModels();
		models.setProvider(provider);

		expect(provider.getModels().map((model) => model.id)).toEqual(["static"]);
		await models.refresh({ providers: [provider.id] });
		expect(provider.getModels().map((model) => model.id)).toEqual(["static", "dynamic"]);
		expect(provider.getModels().map((model) => model.type)).toEqual([undefined, undefined]);
		expect(models.getModelsOfType("image", "legacy").map((model) => model.id)).toEqual(["static"]);
	});

	it("lists chat, image, and all models through typed accessors", () => {
		const models = createModels();
		models.setProvider(
			testProvider({
				id: "p1",
				models: [chatModel("p1", "c1"), imageModel("p1", "i1"), imageModel("p1", "i2")],
			}),
		);
		models.setProvider(testProvider({ id: "p2", models: [imageModel("p2", "i3")] }));

		expect(models.getModels().map((m) => m.id)).toEqual(["c1"]);
		expect(models.getModelsOfType("chat").map((m) => m.id)).toEqual(["c1"]);
		expect(models.getModelsOfType("image").map((m) => m.id)).toEqual(["i1", "i2", "i3"]);
		expect(models.getModelsOfType("image", "p1").map((m) => m.id)).toEqual(["i1", "i2"]);
		expect(models.getModelsOfType("classifier")).toEqual([]);
		expect(models.getAllModels().map((m) => m.id)).toEqual(["c1", "i1", "i2", "i3"]);

		expect(models.getModel("p1", "c1")?.id).toBe("c1");
		expect(models.getModel("p1", "i1")).toBeUndefined();
		expect(models.getModelOfType("chat", "p1", "c1")?.id).toBe("c1");
		expect(models.getModelOfType("image", "p1", "i1")?.id).toBe("i1");
		expect(models.getModelOfType("image", "p1", "c1")).toBeUndefined();
	});

	it("splits available models by type", async () => {
		const models = createModels({ authContext: fakeAuthContext({ KEY: "k" }) });
		models.setProvider(
			testProvider({ id: "p1", envVar: "KEY", models: [chatModel("p1", "c1"), imageModel("p1", "i1")] }),
		);
		models.setProvider(testProvider({ id: "p2", envVar: "MISSING", models: [imageModel("p2", "i2")] }));

		expect((await models.getAvailable()).map((m) => m.id)).toEqual(["c1"]);
		expect((await models.getAvailableOfType("chat")).map((m) => m.id)).toEqual(["c1"]);
		expect((await models.getAvailableOfType("image")).map((m) => m.id)).toEqual(["i1"]);
		expect((await models.getAllAvailable()).map((m) => m.id)).toEqual(["c1", "i1"]);
	});

	it("resolves auth through the provider and merges it into image requests; explicit options win", async () => {
		const calls: GenerateCall[] = [];
		const models = createModels({ authContext: fakeAuthContext({ TEST_KEY: "env-key" }) });
		models.setProvider(testProvider({ id: "p1", envVar: "TEST_KEY", calls }));
		const model = models.getModelOfType("image", "p1", "model-a")!;

		expect((await models.getAuth(model))?.auth.apiKey).toBe("env-key");
		expect((await models.getAuth(model.provider))?.auth.apiKey).toBe("env-key");
		expect((await models.getAuth(model, { apiKey: "explicit-key" }))?.auth.apiKey).toBe("explicit-key");

		const result = await models.generateImages(model, context);
		expect(result.stopReason).toBe("stop");
		expect(calls[0].options?.apiKey).toBe("env-key");

		await models.generateImages(model, context, { apiKey: "explicit" });
		expect(calls[1].options?.apiKey).toBe("explicit");
	});

	it("merges provider-resolved env and applies header transforms", async () => {
		const calls: GenerateCall[] = [];
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "p1",
				auth: {
					apiKey: {
						name: "Test key",
						resolve: async () => ({
							auth: { apiKey: "provider-key", headers: { "x-base": "1" } },
							env: { PROVIDER_ONLY: "provider", SHARED: "provider" },
						}),
					},
				},
				models: [imageModel("p1", "model-a")],
				images: {
					"test-images": {
						generateImages: async (model, _context, options) => {
							calls.push({ model, options });
							return okResult(model);
						},
					},
				},
			}),
		);
		const model = models.getModelOfType("image", "p1", "model-a")!;

		await models.generateImages(model, context, {
			apiKey: "request-key",
			env: { REQUEST_ONLY: "request", SHARED: "request" },
			transformHeaders: (headers) => ({ ...headers, "x-extra": "2" }),
		});

		expect(calls[0].options?.apiKey).toBe("request-key");
		expect(calls[0].options?.env).toEqual({
			PROVIDER_ONLY: "provider",
			REQUEST_ONLY: "request",
			SHARED: "request",
		});
		expect(calls[0].options?.headers).toEqual({ "x-base": "1", "x-extra": "2" });
	});

	it("returns error results instead of rejecting", async () => {
		const models = createModels({ authContext: fakeAuthContext({}) });

		const ghost = await models.generateImages(imageModel("ghost", "m"), context);
		expect(ghost.stopReason).toBe("error");
		expect(ghost.errorMessage).toContain("Unknown provider: ghost");

		// Unconfigured auth is an error, matching stream().
		const calls: GenerateCall[] = [];
		models.setProvider(testProvider({ id: "p1", envVar: "MISSING", calls }));
		const model = models.getModelOfType("image", "p1", "model-a")!;
		expect(await models.getAuth(model)).toBeUndefined();
		const unconfigured = await models.generateImages(model, context);
		expect(unconfigured.stopReason).toBe("error");
		expect(unconfigured.errorMessage).toContain("not configured");
		expect(calls).toEqual([]);

		const controller = new AbortController();
		controller.abort();
		const cancelled = await models.generateImages(model, context, { signal: controller.signal });
		expect(cancelled.stopReason).toBe("aborted");
		expect(calls).toEqual([]);

		// A provider without any images implementation rejects image models it lists.
		models.setProvider(
			createProvider({
				id: "chat-only",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [imageModel("chat-only", "i")],
				api: {
					stream: () => new AssistantMessageEventStream(),
					streamSimple: () => new AssistantMessageEventStream(),
				},
			}),
		);
		const unsupported = await models.generateImages(models.getModelOfType("image", "chat-only", "i")!, context);
		expect(unsupported.stopReason).toBe("error");
		expect(unsupported.errorMessage).toContain("does not support image generation");

		// An images map without the model's api yields a provider error result.
		models.setProvider(
			testProvider({ id: "wrong-api", models: [imageModel("wrong-api", "i")], images: { "other-images": true } }),
		);
		const missingApi = await models.generateImages(models.getModelOfType("image", "wrong-api", "i")!, context);
		expect(missingApi.stopReason).toBe("error");
		expect(missingApi.errorMessage).toContain('no image generation implementation for "test-images"');
	});

	it("rejects chat models at the image entry point at runtime", async () => {
		const models = createModels();
		const chat = chatModel("p1", "chat");
		models.setProvider(testProvider({ id: "p1", models: [chat], images: { "test-chat": true } }));

		const result = await models.generateImages(chat as unknown as ImageModel<ImageApi>, context);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("is not an image model");
	});

	it("rejects image models at the stream entry points at runtime", async () => {
		const models = createModels();
		models.setProvider(testProvider({ id: "p1" }));
		const image = models.getModelOfType("image", "p1", "model-a")!;

		const result = await models.streamSimple(image as unknown as Model<Api>, { messages: [] }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("is not a chat model");
	});

	it("requires at least one concrete operation implementation", () => {
		const createEmptyProvider = (implementations: Pick<CreateProviderOptions, "api" | "images" | "classifiers">) =>
			createProvider({
				id: "empty",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [],
				...implementations,
			});

		const message = 'at least one of "api", "images", or "classifiers"';
		expect(() => createEmptyProvider({})).toThrow(message);
		expect(() => createEmptyProvider({ api: {} })).toThrow(message);
		expect(() => createEmptyProvider({ images: {} })).toThrow(message);
		expect(() => createEmptyProvider({ classifiers: {} })).toThrow(message);
	});

	it("supports dynamic providers listing image models via refresh", async () => {
		let fetches = 0;
		const modelsStore = new InMemoryModelsStore();
		const models = createModels({ modelsStore });
		models.setProvider(
			createProvider({
				id: "dyn",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [],
				fetchModels: async () => {
					fetches++;
					return [imageModel("dyn", "listed"), chatModel("dyn", "chat")];
				},
				images: { "test-images": { generateImages: async (model) => okResult(model) } },
			}),
		);

		expect(models.getAllModels("dyn")).toEqual([]);
		const result = await models.refresh({ providers: ["dyn"] });
		expect(result.errors.size).toBe(0);
		expect(fetches).toBe(1);
		expect(models.getModelOfType("image", "dyn", "listed")).toBeDefined();
		expect(models.getModel("dyn", "chat")).toBeDefined();
		const stored = await modelsStore.read("dyn");
		expect(stored?.models.map((model) => model.id)).toEqual(["listed", "chat"]);
	});

	it("keeps existing built-in and compat model reads chat-only", () => {
		const chat = getBuiltinModels("openrouter");
		const images = getBuiltinImageModels("openrouter");
		const all = getAllBuiltinModels("openrouter");
		const compat = getCompatModels("openrouter");

		expect(chat.every((model) => isModelType(model, "chat"))).toBe(true);
		expect(images.every((model) => isModelType(model, "image"))).toBe(true);
		expect(all.some((model) => isModelType(model, "image"))).toBe(true);
		expect(compat).toEqual(chat);
		expect(chat.every((model) => model.contextWindow > 0)).toBe(true);
		expect(chat.length + images.length + getBuiltinClassifierModels("openrouter").length).toBe(all.length);
		expect(getBuiltinImageModel("openrouter", "black-forest-labs/flux.2-pro").type).toBe("image");
	});

	it("builtinModels exposes OpenRouter image models under the openrouter provider", async () => {
		const models = builtinModels({ authContext: fakeAuthContext({ OPENROUTER_API_KEY: "or-key" }) });
		const provider = models.getProvider("openrouter")!;
		const images = models.getModelsOfType("image", "openrouter");
		expect(images.length).toBeGreaterThan(0);
		expect(provider.getModels().every((model) => isModelType(model, "chat"))).toBe(true);
		expect(provider.getAllModels?.().some((model) => isModelType(model, "image"))).toBe(true);
		expect(images.every((m) => m.type === "image" && m.api === "openrouter-images")).toBe(true);
		expect(models.getModelsOfType("image").every((m) => m.provider === "openrouter")).toBe(true);

		// One upstream id can expose separate chat and image operations.
		const chat = models.getModel("openrouter", "google/gemini-3-pro-image");
		const image = models.getModelOfType("image", "openrouter", "google/gemini-3-pro-image");
		expect(chat?.api).toBe("openai-completions");
		expect(image?.api).toBe("openrouter-images");

		// One credential covers both.
		expect((await models.getAuth(images[0]))?.auth.apiKey).toBe("or-key");
		expect((await models.getAuth(chat!))?.auth.apiKey).toBe("or-key");
		expect(provider.generateImages).toBeDefined();
	});
});
