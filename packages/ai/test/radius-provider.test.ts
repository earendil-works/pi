import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { radiusProvider } from "../src/providers/radius.ts";
import {
	getRadiusAllModelsFromConfig,
	getRadiusModelsFromConfig,
	type RadiusGatewayConfig,
} from "../src/providers/radius-config.ts";

function radiusConfig(): RadiusGatewayConfig {
	return {
		baseUrl: "https://radius.example/v1",
		models: [
			{
				id: "balanced",
				name: "Fresh Balanced",
				reasoning: true,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
				contextWindow: 424242,
				maxTokens: 32000,
			},
			{
				id: "organization-only",
				name: "Organization Only",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16000,
			},
		],
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Radius provider catalogs", () => {
	it("ships a static public catalog for the default gateway", () => {
		const provider = radiusProvider();
		expect(provider.getModels().length).toBeGreaterThan(0);
		expect(provider.getModels()).toContainEqual(
			expect.objectContaining({ id: "balanced", provider: "radius", api: "pi-messages" }),
		);
	});

	it("does not apply the public Radius catalog to custom gateways", () => {
		const provider = radiusProvider({ id: "radius-dev", gateway: "http://localhost:8788" });
		expect(provider.getModels()).toEqual([]);
	});

	it("replaces the static public catalog with refreshed models", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(radiusConfig()), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("radius", async () => ({ type: "api_key", key: "radius-key" }));
		const models = createModels({ credentials });
		models.setProvider(radiusProvider());

		const result = await models.refresh({ providers: ["radius"] });

		expect(result.errors).toEqual(new Map());
		expect(models.getModel("radius", "balanced")).toMatchObject({
			name: "Fresh Balanced",
			baseUrl: "https://radius.example/v1",
			contextWindow: 424242,
		});
		expect(models.getModel("radius", "organization-only")).toBeDefined();
		// Models disabled by the organization must not reappear from the shipped catalog.
		expect(models.getModels("radius").map((model) => model.id)).toEqual(["balanced", "organization-only"]);
	});

	it("replaces the static public catalog with a cached catalog without network access", async () => {
		const store = new InMemoryModelsStore();
		await store.write("radius", {
			models: getRadiusModelsFromConfig("radius", radiusConfig()),
			checkedAt: Date.now(),
		});
		const models = createModels({ modelsStore: store });
		models.setProvider(radiusProvider());

		await models.refresh({ providers: ["radius"], allowNetwork: false });

		expect(models.getModel("radius", "balanced")?.name).toBe("Fresh Balanced");
		expect(models.getModel("radius", "organization-only")).toBeDefined();
		expect(models.getModels("radius").map((model) => model.id)).toEqual(["balanced", "organization-only"]);
	});

	it("exposes no models when the organization disabled all of them", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ baseUrl: "https://radius.example/v1", models: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("radius", async () => ({ type: "api_key", key: "radius-key" }));
		const models = createModels({ credentials });
		models.setProvider(radiusProvider());

		const result = await models.refresh({ providers: ["radius"] });

		expect(result.errors).toEqual(new Map());
		expect(models.getModels("radius")).toEqual([]);
	});

	it("exposes classifier models from /v1/config without listing them in getModels()", async () => {
		const config: RadiusGatewayConfig = {
			...radiusConfig(),
			classifiers: [
				{
					id: "jev-latest",
					name: "TypeSafe: Jev Latest",
					input: ["text"],
					cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 262144,
				},
			],
		};
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith("/v1/config")) {
				return new Response(JSON.stringify(config), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === "https://radius.example/v1/decision") {
				return new Response(
					JSON.stringify({
						answers: { approved: { type: "bool", probability: 0.91 } },
						usage: {
							input: 50,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 51,
							cost: { input: 0.00001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.00001 },
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

		const store = new InMemoryModelsStore();
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("radius", async () => ({ type: "api_key", key: "radius-key" }));
		const models = createModels({ credentials, modelsStore: store });
		models.setProvider(radiusProvider());

		await models.refresh({ providers: ["radius"] });

		expect(models.getModels("radius").map((model) => model.id)).toEqual(["balanced", "organization-only"]);
		const classifier = models.getModelOfType("classifier", "radius", "jev-latest");
		expect(classifier).toMatchObject({
			type: "classifier",
			api: "pi-decision",
			provider: "radius",
			baseUrl: "https://radius.example/v1",
			contextWindow: 262144,
		});

		const classified = await models.classify(classifier!, {
			state: { ok: true },
			questions: {
				approved: { type: "bool", instructions: "Approved?", criteria: { true: "yes", false: "no" } },
			},
		});
		expect(classified.stopReason).toBe("stop");
		expect(classified.answers.approved).toEqual({ type: "bool", probability: 0.91 });
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// Restores classifiers from cache without network access.
		const cachedModels = createModels({ credentials, modelsStore: store });
		cachedModels.setProvider(radiusProvider());
		await cachedModels.refresh({ providers: ["radius"], allowNetwork: false });
		expect(cachedModels.getModelOfType("classifier", "radius", "jev-latest")).toEqual(
			getRadiusAllModelsFromConfig("radius", config).find((m) => m.id === "jev-latest"),
		);
	});

	it("exposes image models from /v1/config without listing them in getModels()", async () => {
		const config: RadiusGatewayConfig = {
			...radiusConfig(),
			images: [
				{
					id: "nano-banana",
					name: "Nano Banana",
					input: ["text", "image"],
					output: ["image", "text"],
					cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.083333 },
				},
			],
		};
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith("/v1/config")) {
				return new Response(JSON.stringify(config), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === "https://radius.example/v1/image") {
				return new Response(
					JSON.stringify({
						output: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
						usage: {
							input: 12,
							output: 1290,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 1302,
							cost: {
								input: 0.000004,
								output: 0.003225,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0.003229,
								totalFromProvider: true,
							},
						},
						responseId: "gen-img-radius-1",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

		const store = new InMemoryModelsStore();
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("radius", async () => ({ type: "api_key", key: "radius-key" }));
		const models = createModels({ credentials, modelsStore: store });
		models.setProvider(radiusProvider());

		await models.refresh({ providers: ["radius"] });

		expect(models.getModels("radius").map((model) => model.id)).toEqual(["balanced", "organization-only"]);
		const imageModel = models.getModelOfType("image", "radius", "nano-banana");
		expect(imageModel).toMatchObject({
			type: "image",
			api: "pi-image",
			provider: "radius",
			baseUrl: "https://radius.example/v1",
			input: ["text", "image"],
			output: ["image", "text"],
		});

		const generated = await models.generateImages(imageModel!, {
			input: [{ type: "text", text: "A fox" }],
		});
		expect(generated.stopReason).toBe("stop");
		expect(generated.output).toEqual([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
		expect(generated.responseId).toBe("gen-img-radius-1");
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// Restores image models from cache without network access.
		const cachedModels = createModels({ credentials, modelsStore: store });
		cachedModels.setProvider(radiusProvider());
		await cachedModels.refresh({ providers: ["radius"], allowNetwork: false });
		expect(cachedModels.getModelOfType("image", "radius", "nano-banana")).toEqual(
			getRadiusAllModelsFromConfig("radius", config).find((m) => m.id === "nano-banana"),
		);
	});

	it("skips image models whose output omits image and filters unknown modalities", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					...radiusConfig(),
					images: [
						{
							id: "text-only-bad",
							name: "Not An Image Model",
							input: ["text"],
							output: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
						{
							id: "valid-with-extra",
							name: "Valid Image Model",
							input: ["text", "audio", "image"],
							output: ["image", "video", "text"],
							cost: { input: 0.3, output: 2.5, cacheRead: 0, cacheWrite: 0 },
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("radius", async () => ({ type: "api_key", key: "radius-key" }));
		const models = createModels({ credentials });
		models.setProvider(radiusProvider());

		await models.refresh({ providers: ["radius"] });

		expect(models.getModelOfType("image", "radius", "text-only-bad")).toBeUndefined();
		expect(models.getModelOfType("image", "radius", "valid-with-extra")).toMatchObject({
			input: ["text", "image"],
			output: ["image", "text"],
		});
	});
});
