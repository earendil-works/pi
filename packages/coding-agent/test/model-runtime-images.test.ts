import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AnyModel,
	type Api,
	type AssistantImages,
	type ClassifierModel,
	createProvider,
	type ImageModel,
	type ImagesOptions,
	InMemoryModelsStore,
	isModelType,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function imageModel(provider: string, id: string): ImageModel<"test-images"> {
	return {
		type: "image",
		id,
		name: id,
		api: "test-images",
		provider,
		baseUrl: "https://images.test/v1",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function classifierModel(provider: string, id: string): ClassifierModel<"test-classifier"> {
	return {
		type: "classifier",
		id,
		name: id,
		api: "test-classifier",
		provider,
		baseUrl: "https://classifier.test/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
	};
}

const context = { input: [{ type: "text" as const, text: "a red circle" }] };
const classifierContext = {
	state: { text: "Looks good" },
	questions: {
		approved: {
			type: "bool" as const,
			instructions: "Does this express approval?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
};

function okImageResult(model: ImageModel<string>): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("ModelRuntime image generation", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function createRuntime(modelsJson?: object): Promise<ModelRuntime> {
		let modelsPath: string | null = null;
		if (modelsJson) {
			const dir = mkdtempSync(join(tmpdir(), "pi-images-"));
			tempDirs.push(dir);
			modelsPath = join(dir, "models.json");
			writeFileSync(modelsPath, JSON.stringify(modelsJson));
		}
		return ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath,
			allowModelNetwork: false,
		});
	}

	it("lists built-in OpenRouter image models separately from chat models", async () => {
		const runtime = await createRuntime();
		const images = runtime.getModelsOfType("image", "openrouter");
		expect(images.length).toBeGreaterThan(0);
		expect(runtime.getModels("openrouter").every((model) => isModelType(model, "chat"))).toBe(true);
		expect(runtime.getModelOfType("image", "openrouter", images[0].id)).toBe(images[0]);
		expect(runtime.getModel("openrouter", "google/gemini-3-pro-image")?.api).toBe("openai-completions");
		expect(runtime.getModelOfType("image", "openrouter", "google/gemini-3-pro-image")?.type).toBe("image");
		const classifiers = runtime.getModelsOfType("classifier", "openrouter");
		expect(runtime.getAllModels("openrouter").length).toBe(
			runtime.getModels("openrouter").length + images.length + classifiers.length,
		);
	});

	it("extension model lists replace undeclared models of every operation", async () => {
		const runtime = await createRuntime();
		const chat: Model<"test-chat"> = {
			id: "built-in-chat",
			name: "Built-in chat",
			api: "test-chat",
			provider: "mixed",
			baseUrl: "https://built-in.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};
		runtime.registerNativeProvider(
			createProvider({
				id: "mixed",
				auth: { apiKey: { name: "Mixed key", resolve: async () => ({ auth: {} }) } },
				models: [chat, imageModel("mixed", "built-in-image"), classifierModel("mixed", "built-in-classifier")],
				images: { "test-images": { generateImages: async (model) => okImageResult(model) } },
			}),
		);

		runtime.registerProvider("mixed", {
			apiKey: "extension-secret",
			models: [{ ...chat, id: "extension-chat", name: "Extension chat", baseUrl: "https://chat-proxy.test/v1" }],
		});

		expect(runtime.getAllModels("mixed").map((model) => [model.type ?? "chat", model.id])).toEqual([
			["chat", "extension-chat"],
		]);
		expect(runtime.getModel("mixed", "extension-chat")?.baseUrl).toBe("https://chat-proxy.test/v1");
		expect(runtime.getModelsOfType("image", "mixed")).toEqual([]);
		expect(runtime.getModelsOfType("classifier", "mixed")).toEqual([]);
	});

	it("registers extension image and classifier models with their implementations", async () => {
		const runtime = await createRuntime();
		const observed: Array<{ apiKey: string | undefined; headers: unknown }> = [];
		runtime.registerProvider("extension-operations", {
			apiKey: "extension-secret",
			models: [
				{ ...imageModel("ignored", "shared"), headers: { "X-Operation": "image" } },
				{ ...classifierModel("ignored", "shared"), headers: { "X-Operation": "classifier" } },
			],
			images: {
				"test-images": {
					generateImages: async (model, _context, options) => {
						observed.push({ apiKey: options?.apiKey, headers: options?.headers });
						return okImageResult(model);
					},
				},
			},
			classifiers: {
				"test-classifier": {
					classify: async (model, _context, options) => {
						observed.push({ apiKey: options?.apiKey, headers: options?.headers });
						return {
							api: model.api,
							provider: model.provider,
							model: model.id,
							answers: { approved: { type: "bool", probability: 0.9 } },
							stopReason: "stop",
							timestamp: 0,
						};
					},
				},
			},
		});

		const image = runtime.getModelOfType("image", "extension-operations", "shared")!;
		const classifier = runtime.getModelOfType("classifier", "extension-operations", "shared")!;
		expect((await runtime.generateImages(image, context)).stopReason).toBe("stop");
		expect((await runtime.classify(classifier, classifierContext)).stopReason).toBe("stop");
		expect(observed).toEqual([
			{ apiKey: "extension-secret", headers: { "X-Operation": "image" } },
			{ apiKey: "extension-secret", headers: { "X-Operation": "classifier" } },
		]);
	});

	it("generates images through a native provider with runtime-resolved auth", async () => {
		const runtime = await createRuntime();
		const calls: Array<{ model: AnyModel; options: ImagesOptions | undefined }> = [];
		runtime.registerNativeProvider(
			createProvider({
				id: "pixels",
				auth: {
					apiKey: {
						name: "Pixels key",
						resolve: async ({ credential }) =>
							credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
					},
				},
				models: [imageModel("pixels", "flux")],
				images: {
					"test-images": {
						generateImages: async (model, _context, options) => {
							calls.push({ model, options });
							return {
								api: model.api,
								provider: model.provider,
								model: model.id,
								output: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
								stopReason: "stop",
								timestamp: 0,
							};
						},
					},
				},
			}),
		);
		const model = runtime.getModelOfType("image", "pixels", "flux")!;

		const unconfigured = await runtime.generateImages(model, context);
		expect(unconfigured.stopReason).toBe("error");
		expect(unconfigured.errorMessage).toContain("not configured");
		expect(calls).toEqual([]);

		const controller = new AbortController();
		controller.abort();
		const cancelled = await runtime.generateImages(model, context, { signal: controller.signal });
		expect(cancelled.stopReason).toBe("aborted");
		expect(calls).toEqual([]);

		await runtime.setRuntimeApiKey("pixels", "sk-pixels");
		expect((await runtime.getAvailableOfType("image", "pixels")).map((entry) => entry.id)).toEqual(["flux"]);
		const result = await runtime.generateImages(model, context);
		expect(result.stopReason).toBe("stop");
		expect(calls[0].options?.apiKey).toBe("sk-pixels");
	});

	it("rejects image models at every chat entry point before provider dispatch", async () => {
		const runtime = await createRuntime();
		let chatDispatches = 0;
		const rejectDispatch = (): never => {
			chatDispatches++;
			throw new Error("image reached chat adapter");
		};
		runtime.registerNativeProvider(
			createProvider({
				id: "hybrid",
				auth: {
					apiKey: {
						name: "Hybrid key",
						resolve: async ({ credential }) =>
							credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
					},
				},
				models: [imageModel("hybrid", "shared")],
				api: {
					stream: rejectDispatch,
					streamSimple: rejectDispatch,
					fetchDeferred: rejectDispatch,
					cancelDeferred: async () => rejectDispatch(),
				},
			}),
		);
		await runtime.setRuntimeApiKey("hybrid", "sk-hybrid");
		const image = runtime.getModelOfType("image", "hybrid", "shared")!;
		const chat = image as unknown as Model<Api>;
		const chatContext = { messages: [] };
		const handle = { provider: "hybrid", modelId: image.id, api: image.api, id: "response-1" };

		const results = [
			await runtime.stream(chat, chatContext).result(),
			await runtime.complete(chat, chatContext),
			await runtime.streamSimple(chat, chatContext).result(),
			await runtime.completeSimple(chat, chatContext),
			await runtime.streamDeferred(chat, handle).result(),
			await runtime.fetchDeferred(chat, handle),
		];
		for (const result of results) {
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("is not a chat model");
		}
		await expect(runtime.cancelDeferred(chat, handle)).rejects.toThrow("is not a chat model");
		expect(chatDispatches).toBe(0);
	});

	it("keeps image generation on a built-in provider composed with models.json overrides", async () => {
		const runtime = await createRuntime({
			providers: {
				openrouter: {
					headers: { "X-Title": "pi" },
					modelOverrides: {
						"openrouter/auto": { name: "Auto (renamed)" },
						"google/gemini-3-pro-image": { headers: { "X-Chat-Only": "yes" } },
					},
				},
			},
		});
		const provider = runtime.getProvider("openrouter")!;
		expect(provider.generateImages).toBeDefined();
		expect(runtime.getModel("openrouter", "openrouter/auto")?.name).toBe("Auto (renamed)");
		expect(runtime.getModelsOfType("image", "openrouter").length).toBeGreaterThan(0);

		// Auth is provider-scoped: the same key serves chat and image models.
		await runtime.setRuntimeApiKey("openrouter", "sk-or");
		const chat = runtime.getModel("openrouter", "google/gemini-3-pro-image")!;
		const image = runtime.getModelOfType("image", "openrouter", "google/gemini-3-pro-image")!;
		const chatAuth = await runtime.getAuth(chat);
		const imageAuth = await runtime.getAuth(image);
		expect(imageAuth?.auth.apiKey).toBe("sk-or");
		expect(chatAuth?.auth.headers).toMatchObject({ "X-Title": "pi", "X-Chat-Only": "yes" });
		expect(imageAuth?.auth.headers).toEqual({ "X-Title": "pi" });
	});

	it("does not add image generation or classification to composed chat-only providers", async () => {
		const runtime = await createRuntime({
			providers: { anthropic: { headers: { "X-Title": "pi" } } },
		});
		const provider = runtime.getProvider("anthropic")!;
		expect(provider.generateImages).toBeUndefined();
		expect(provider.classify).toBeUndefined();
		expect(runtime.getProvider("openrouter")?.generateImages).toBeDefined();
		expect(runtime.getProvider("typesafe")?.classify).toBeDefined();
	});
});
