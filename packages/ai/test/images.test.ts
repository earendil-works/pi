import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getImageModel } from "../src/image-models.js";
import { generateImages } from "../src/images.js";
import type { ImageContent, ImagesContext, ImagesModel, ProviderImagesOptions } from "../src/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type ImagesOptionsWithExtras = ProviderImagesOptions & Record<string, unknown>;

async function basicImageGeneration<TApi extends string>(model: ImagesModel<TApi>, options?: ImagesOptionsWithExtras) {
	const context: ImagesContext = {
		input: [{ type: "text", text: "Generate a simple red circle on a plain white background. No text." }],
	};

	const response = await generateImages(model, context, options);

	expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
	expect(response.errorMessage).toBeFalsy();
	expect(response.output.some((item) => item.type === "image")).toBe(true);
	expect(response.timestamp).toBeGreaterThan(0);
}

async function handleTextAndImageOutput<TApi extends string>(
	model: ImagesModel<TApi>,
	options?: ImagesOptionsWithExtras,
) {
	if (!model.output.includes("text")) {
		console.log(`Skipping text+image output test - model ${model.id} doesn't support text output`);
		return;
	}

	const context: ImagesContext = {
		input: [{ type: "text", text: "Generate a red circle and include a brief description of the image." }],
	};

	const response = await generateImages(model, context, options);

	expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
	expect(response.output.some((item) => item.type === "image")).toBe(true);
	expect(response.output.some((item) => item.type === "text" && item.text.trim().length > 0)).toBe(true);
}

async function handleImageInput<TApi extends string>(model: ImagesModel<TApi>, options?: ImagesOptionsWithExtras) {
	if (!model.input.includes("image")) {
		console.log(`Skipping image input test - model ${model.id} doesn't support image input`);
		return;
	}

	const imagePath = join(__dirname, "data", "red-circle.png");
	const imageBuffer = readFileSync(imagePath);
	const imageContent: ImageContent = {
		type: "image",
		data: imageBuffer.toString("base64"),
		mimeType: "image/png",
	};

	const context: ImagesContext = {
		input: [{ type: "text", text: "Create a variation of this image with a blue background." }, imageContent],
	};

	const response = await generateImages(model, context, options);

	expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
	expect(response.output.some((item) => item.type === "image")).toBe(true);
}

describe("Images E2E Tests", () => {
	describe.skipIf(!process.env.OPENROUTER_API_KEY)(
		"OpenRouter Images Provider (google/gemini-2.5-flash-image)",
		() => {
			const model = getImageModel("openrouter", "google/gemini-2.5-flash-image");

			it("should generate a basic image", { retry: 3 }, async () => {
				await basicImageGeneration(model);
			});

			it("should handle text plus image output", { retry: 3 }, async () => {
				await handleTextAndImageOutput(model);
			});

			it("should handle image input", { retry: 3 }, async () => {
				await handleImageInput(model);
			});
		},
	);
});
