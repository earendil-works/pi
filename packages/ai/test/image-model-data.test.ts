import { describe, expect, it } from "vitest";
import { parseOpenRouterImageModels } from "../scripts/generate-image-models.ts";

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
