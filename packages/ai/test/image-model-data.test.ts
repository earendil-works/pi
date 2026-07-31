import { describe, expect, it } from "vitest";
import { createMiniMaxImageModels, parseOpenRouterImageModels } from "../scripts/generate-image-models.ts";

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

describe("MiniMax image model generation", () => {
	it("creates global and CN catalogs for both target models", () => {
		const models = createMiniMaxImageModels();

		expect(Object.keys(models)).toEqual(["minimax", "minimax-cn"]);
		expect(models.minimax.map((model) => model.id)).toEqual(["image-01", "image-01-live"]);
		expect(models["minimax-cn"].map((model) => model.id)).toEqual(["image-01", "image-01-live"]);
		expect(models.minimax.every((model) => model.baseUrl === "https://api.minimax.io/v1/image_generation")).toBe(
			true,
		);
		expect(
			models["minimax-cn"].every((model) => model.baseUrl === "https://api.minimaxi.com/v1/image_generation"),
		).toBe(true);
	});
});
