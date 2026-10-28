import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels, createProvider, getModelType } from "../src/models.ts";
import {
	builtinModels,
	getAllBuiltinModels,
	getBuiltinClassifierModel,
	getBuiltinClassifierModels,
} from "../src/providers/all.ts";
import type { Api, ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function classifierModel(provider: string, id: string): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		id,
		name: id,
		api: "test-classifier",
		provider,
		baseUrl: "https://example.test/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
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

const context: ClassifierContext = {
	state: { text: "yes" },
	questions: {
		approved: {
			type: "bool",
			instructions: "Does this express approval?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
};

describe("Models with classifier models", () => {
	it("keeps chat and classifier entries with the same provider and id separate", async () => {
		const chat = chatModel("test", "shared");
		const classifier = classifierModel("test", "shared");
		const provider = createProvider({
			id: "test",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [chat, classifier],
			api: {
				"test-chat": {
					stream: () => new AssistantMessageEventStream(),
					streamSimple: () => new AssistantMessageEventStream(),
				},
			},
			classifiers: {
				"test-classifier": {
					classify: async (model): Promise<ClassifierResult> => ({
						api: model.api,
						provider: model.provider,
						model: model.id,
						answers: { approved: { type: "bool", probability: 0.9 } },
						stopReason: "stop",
						timestamp: Date.now(),
					}),
				},
			},
		});
		const models = createModels();
		models.setProvider(provider);

		const listedChat = models.getModel("test", "shared");
		expect(listedChat && getModelType(listedChat)).toBe("chat");
		expect(models.getModelOfType("classifier", "test", "shared")?.type).toBe("classifier");
		expect(models.getModelsOfType("classifier")).toEqual([classifier]);
		expect(models.getAllModels()).toHaveLength(2);
		expect(await models.getAvailableOfType("classifier")).toEqual([classifier]);
		expect((await models.classify(classifier, context)).answers.approved).toEqual({
			type: "bool",
			probability: 0.9,
		});
	});

	it("rejects chat models at the classifier entry point at runtime", async () => {
		const chat = chatModel("test", "chat");
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "test",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [chat],
				api: {
					stream: () => new AssistantMessageEventStream(),
					streamSimple: () => new AssistantMessageEventStream(),
				},
			}),
		);

		const result = await models.classify(chat as unknown as ClassifierModel<ClassifierApi>, context);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("is not a classifier model");
	});

	it("exposes Jev only through classifier catalog accessors", () => {
		const jev = getBuiltinClassifierModel("typesafe", "jev-latest");
		expect(jev).toMatchObject({
			type: "classifier",
			api: "typesafe-system-one",
			provider: "typesafe",
			contextWindow: 64000,
		});
		expect(getBuiltinClassifierModels("typesafe")).toEqual([jev]);
		expect(getAllBuiltinModels("typesafe")).toEqual([jev]);

		const models = builtinModels();
		expect(models.getModel("typesafe", "jev-latest")).toBeUndefined();
		expect(models.getModelOfType("classifier", "typesafe", "jev-latest")).toEqual(jev);
	});

	it.each([
		["vercel-ai-gateway", "typesafe-ai/jev", "https://ai-gateway.vercel.sh/typesafe/v1/systemone"],
		["opencode", "jev-1.13", "https://opencode.ai/inference/systemone/v1/systemone"],
		["opencode", "jev-1.13-free", "https://opencode.ai/inference/systemone/v1/systemone"],
	])("routes %s Jev (%s) to its TypeSafe-compatible endpoint", async (provider, id, url) => {
		const models = builtinModels();
		const jev = models.getModelOfType("classifier", provider, id);
		if (!jev) throw new Error(`missing ${provider} Jev model`);
		expect(jev).toMatchObject({ api: "typesafe-system-one", contextWindow: 32000 });
		expect(models.getModel(provider, id)).toBeUndefined();

		const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
		const result = await models.classify(jev, context, {
			apiKey: "secret",
			fetch: async (input, init) => {
				requests.push({
					url: String(input),
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
					authorization: new Headers(init?.headers).get("authorization"),
				});
				return Response.json({ model: id, answers: { approved: { type: "noul", noul: 0.8 } } });
			},
		});

		expect(requests).toEqual([
			{
				url,
				body: expect.objectContaining({ model: id, state: context.state }),
				authorization: "Bearer secret",
			},
		]);
		expect(result.stopReason).toBe("stop");
		expect(result.answers.approved).toEqual({ type: "bool", probability: 0.8 });
	});

	it("rejects images for classifier models without image input before calling the provider", async () => {
		const classifier = classifierModel("test", "text-only");
		const classify = vi.fn(
			async (): Promise<ClassifierResult> => ({
				api: classifier.api,
				provider: classifier.provider,
				model: classifier.id,
				answers: {},
				stopReason: "stop",
				timestamp: Date.now(),
			}),
		);
		const models = createModels();
		models.setProvider(
			createProvider({
				id: "test",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [classifier],
				classifiers: { "test-classifier": { classify } },
			}),
		);

		const result = await models.classify(classifier, {
			...context,
			images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
		});
		const withoutImages = await models.classify(classifier, { ...context, images: [] });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Model test/text-only does not accept image input");
		expect(withoutImages.stopReason).toBe("stop");
		expect(classify).toHaveBeenCalledOnce();
	});

	it("routes OpenAI GPT-6 Luna through the Decisions API with images", async () => {
		const models = builtinModels();
		const luna = models.getModelOfType("classifier", "openai", "gpt-6-luna");
		if (!luna) throw new Error("missing OpenAI Decisions model");
		expect(luna).toMatchObject({ api: "openai-decisions", input: ["text", "image"], contextWindow: 922000 });
		// The chat entry with the same id stays separate.
		expect(models.getModel("openai", "gpt-6-luna")?.api).toBe("openai-responses");

		const urls: string[] = [];
		const result = await models.classify(
			luna,
			{ ...context, images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] },
			{
				apiKey: "secret",
				fetch: async (input) => {
					urls.push(String(input));
					return Response.json({ answers: [{ type: "predicate", name: "approved", probability: 0.8 }] });
				},
			},
		);

		expect(urls).toEqual(["https://api.openai.com/v1/decisions"]);
		expect(result.stopReason).toBe("stop");
		expect(result.answers.approved).toEqual({ type: "bool", probability: 0.8 });
	});

	it("lists OpenAI Decisions models only for API key credentials", async () => {
		const apiKeyStore = new InMemoryCredentialStore();
		await apiKeyStore.modify("openai", async () => ({ type: "api_key", key: "secret" }));
		const oauthStore = new InMemoryCredentialStore();
		await oauthStore.modify("openai", async () => ({
			type: "oauth",
			access: "access",
			refresh: "refresh",
			expires: Date.now() + 3_600_000,
		}));

		const withApiKey = builtinModels({ credentials: apiKeyStore });
		const withOAuth = builtinModels({ credentials: oauthStore });

		expect((await withApiKey.getAvailableOfType("classifier", "openai")).map((model) => model.id)).toEqual([
			"gpt-6-luna",
		]);
		expect(await withOAuth.getAvailableOfType("classifier", "openai")).toEqual([]);
		// Chat models stay available with ChatGPT OAuth.
		expect((await withOAuth.getAvailable("openai")).some((model) => model.id === "gpt-6-luna")).toBe(true);
	});

	it("routes OpenRouter classifier models through the System One API", () => {
		const models = builtinModels();
		for (const model of getBuiltinClassifierModels("openrouter")) {
			expect(model).toMatchObject({
				api: "typesafe-system-one",
				baseUrl: "https://openrouter.ai/api/v1",
				// Explicit, so images keep OpenRouter's form when the baseUrl is overridden.
				compat: { imageInput: "state-image-urls", sendImageOptInHeader: false },
			});
			expect(models.getModel("openrouter", model.id)).toBeUndefined();
			expect(models.getModelOfType("classifier", "openrouter", model.id)).toEqual(model);
		}
	});
});
