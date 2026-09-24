import { describe, expect, it } from "vitest";
import { getModel as getCompatModel } from "../src/compat.ts";
import {
	createModels,
	createProvider,
	getModelType,
	hasApi,
	isModelType,
	modelsAreEqual,
	type Provider,
} from "../src/models.ts";
import { InMemoryModelsStore, type ModelsStoreEntry } from "../src/models-store.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { fauxAssistantMessage, fauxProvider } from "../src/providers/faux.ts";
import type { Api, ImageApi, ImageModel, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

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

const noAuth = { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } };
const chatStreams = {
	stream: () => new AssistantMessageEventStream(),
	streamSimple: () => new AssistantMessageEventStream(),
};

describe("chat models without a type", () => {
	it("work through a handwritten provider without getAllModels", async () => {
		const faux = fauxProvider({ provider: "handwritten" });
		const handwritten: Provider = {
			id: "handwritten",
			name: "Handwritten",
			auth: faux.provider.auth,
			getModels: () => faux.models,
			stream: faux.provider.stream,
			streamSimple: faux.provider.streamSimple,
		};
		const models = createModels();
		models.setProvider(handwritten);

		const model = models.getModel("handwritten", faux.models[0].id);
		expect(model).toBeDefined();
		expect(model?.type).toBeUndefined();
		expect(getModelType(model!)).toBe("chat");
		expect(hasApi(model!, model!.api)).toBe(true);
		expect(modelsAreEqual(model, { ...model!, type: "chat" })).toBe(true);
		expect(modelsAreEqual(model, { ...imageModel(model!.provider, model!.id) })).toBe(false);
		expect(models.getModelsOfType("chat", "handwritten")).toEqual(faux.models);
		expect(models.getAllModels("handwritten")).toEqual(faux.models);
		expect(models.getModelsOfType("image", "handwritten")).toEqual([]);

		faux.setResponses([fauxAssistantMessage("hi")]);
		const result = await models.complete(model!, { messages: [{ role: "user", content: "hi", timestamp: 0 }] });
		expect(result.stopReason).toBe("stop");
	});

	it("narrow mixed lists with isModelType", () => {
		const mixed = [chatModel("p", "c"), { ...chatModel("p", "typed"), type: "chat" as const }, imageModel("p", "i")];
		expect(mixed.filter((model) => isModelType(model, "chat")).map((model) => model.id)).toEqual(["c", "typed"]);
		expect(mixed.filter((model) => isModelType(model, "image")).map((model) => model.id)).toEqual(["i"]);
		expect(mixed.filter((model) => isModelType(model, "classifier"))).toEqual([]);
	});
});

describe("built-in catalog getters", () => {
	it("return model shapes that can be reassigned within one api", () => {
		// Compile-time regression check: the return type must not carry literal model ids.
		let model = getBuiltinModel("openai", "gpt-4o-mini");
		model = getBuiltinModel("openai", "gpt-4o");
		let compat = getCompatModel("openai", "gpt-4o-mini");
		compat = getCompatModel("openai", "gpt-4o");

		expect(model.id).toBe("gpt-4o");
		expect(compat.id).toBe("gpt-4o");
	});
});

describe("stored and fetched models of unknown types", () => {
	it("are dropped instead of failing the refresh", async () => {
		const modelsStore = new InMemoryModelsStore();
		const stored = {
			models: [
				chatModel("dyn", "stored-chat"),
				imageModel("dyn", "stored-image"),
				{ ...chatModel("dyn", "future-embedding"), type: "embedding" },
				{ ...imageModel("dyn", "future-video"), type: "video" },
			],
		} as unknown as ModelsStoreEntry;
		await modelsStore.write("dyn", stored);

		let fetched: unknown[] = [];
		const models = createModels({ modelsStore });
		models.setProvider(
			createProvider({
				id: "dyn",
				auth: noAuth,
				models: [],
				fetchModels: async () => fetched as Model<Api>[],
				api: chatStreams,
			}),
		);

		const restored = await models.refresh({ providers: ["dyn"], allowNetwork: false });
		expect(restored.errors.size).toBe(0);
		expect(models.getAllModels("dyn").map((model) => model.id)).toEqual(["stored-chat", "stored-image"]);

		fetched = [chatModel("dyn", "fetched-chat"), { ...imageModel("dyn", "fetched-video"), type: "video" }];
		const refreshed = await models.refresh({ providers: ["dyn"] });
		expect(refreshed.errors.size).toBe(0);
		expect(models.getAllModels("dyn").map((model) => model.id)).toEqual(["fetched-chat"]);
		expect(await modelsStore.read("dyn")).toMatchObject({ models: [{ id: "fetched-chat" }] });
	});
});
