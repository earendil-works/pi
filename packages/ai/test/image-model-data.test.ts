import { describe, expect, it } from "vitest";
import { createMiniMaxImageModels, parseOpenRouterImageModels } from "../scripts/generate-image-models.ts";
import { IMAGE_MODELS } from "../src/image-models.generated.ts";

const validImageModel = {
	id: "example/image-model",
	name: "Example Image Model",
	architecture: {
		input_modalities: ["text", "image"],
		output_modalities: ["image"],
	},
	pricing: {
		prompt: "0.000001",
		completion: "0.000002",
	},
};

describe("OpenRouter image model parsing", () => {
	it.each([{}, { data: [] }, { data: "invalid" }])("rejects a missing or empty strict catalog", (payload) => {
		expect(() => parseOpenRouterImageModels(payload, true)).toThrow("missing or empty image model list");
	});

	it("rejects a strict catalog with no usable image models", () => {
		expect(() =>
			parseOpenRouterImageModels(
				{
					data: [
						{
							...validImageModel,
							architecture: { input_modalities: ["text"], output_modalities: ["text"] },
						},
					],
				},
				true,
			),
		).toThrow("no usable image models");
	});

	it("parses a non-empty image model catalog", () => {
		expect(parseOpenRouterImageModels({ data: [validImageModel] }, true)).toEqual([
			expect.objectContaining({
				id: "example/image-model",
				input: ["text", "image"],
				output: ["image"],
			}),
		]);
	});
});

describe("MiniMax image model catalog", () => {
	const models = createMiniMaxImageModels();

	it("covers the global and regional endpoints", () => {
		expect(models.minimax.map((model) => model.baseUrl)).toEqual([
			"https://api.minimax.io/v1/image_generation",
			"https://api.minimax.io/v1/image_generation",
		]);
		expect(models["minimax-cn"].map((model) => model.baseUrl)).toEqual([
			"https://api.minimaxi.com/v1/image_generation",
			"https://api.minimaxi.com/v1/image_generation",
		]);
	});

	it("accepts reference images on every model", () => {
		for (const providerModels of Object.values(models)) {
			expect(providerModels.map((model) => model.id)).toEqual(["image-01", "image-01-live"]);
			expect(providerModels.every((model) => model.input.includes("image"))).toBe(true);
			expect(providerModels.every((model) => model.api === "minimax-images")).toBe(true);
		}
	});

	it("matches the generated catalog", () => {
		expect(Object.values(IMAGE_MODELS.minimax)).toEqual(models.minimax);
		expect(Object.values(IMAGE_MODELS["minimax-cn"])).toEqual(models["minimax-cn"]);
	});
});
