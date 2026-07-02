#!/usr/bin/env node

import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { DEEPINFRA_BASE_URL, type DeepInfraCatalogModel, DEEPINFRA_MODELS_URL } from "../src/api/deepinfra.ts";
import type { ImagesModel, KnownImagesApi, KnownImagesProvider } from "../src/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// DeepInfra tags every image model `image-gen` with no separate edit tag, but many
// require a source image (Kontext/Redux/Qwen-Image-Edit, Bria background ops), which
// the text-to-image `images/generations` surface cannot drive. Exclude them until
// image-input editing is plumbed through.
const DEEPINFRA_IMAGE_EDIT_RE = /(?:edit|kontext|redux|remove_background|erase_foreground|blur_background|expand)/i;

interface OpenRouterModelRecord {
	id: string;
	name: string;
	context_length?: number;
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
	};
}

async function fetchOpenRouterImageModels(): Promise<ImagesModel<"openrouter-images">[]> {
	try {
		console.log("Fetching image models from OpenRouter API...");
		const response = await fetch(`${OPENROUTER_BASE_URL}/models?output_modalities=image`);
		const data = (await response.json()) as { data?: OpenRouterModelRecord[] };
		const models: ImagesModel<"openrouter-images">[] = [];

		for (const model of data.data ?? []) {
			const input = Array.from(
				new Set(
					(model.architecture?.input_modalities ?? [])
						.filter((modality): modality is "text" | "image" => modality === "text" || modality === "image"),
				),
			);
			const output = Array.from(
				new Set(
					(model.architecture?.output_modalities ?? []).filter(
						(modality): modality is "text" | "image" => modality === "text" || modality === "image",
					),
				),
			);

			if (!output.includes("image")) continue;
			if (input.length === 0) input.push("text");

			models.push({
				id: model.id,
				name: model.name,
				api: "openrouter-images",
				provider: "openrouter",
				baseUrl: OPENROUTER_BASE_URL,
				input,
				output,
				cost: {
					input: parseFloat(model.pricing?.prompt || "0") * 1_000_000,
					output: parseFloat(model.pricing?.completion || "0") * 1_000_000,
					cacheRead: parseFloat(model.pricing?.input_cache_read || "0") * 1_000_000,
					cacheWrite: parseFloat(model.pricing?.input_cache_write || "0") * 1_000_000,
				},
			});
		}

		console.log(`Fetched ${models.length} image models from OpenRouter`);
		return models;
	} catch (error) {
		console.error("Failed to fetch OpenRouter image models:", error);
		return [];
	}
}

async function fetchDeepInfraImageModels(): Promise<ImagesModel<"deepinfra-images">[]> {
	try {
		console.log("Fetching image models from DeepInfra API...");
		const response = await fetch(DEEPINFRA_MODELS_URL);
		const data = (await response.json()) as { data?: DeepInfraCatalogModel[] };
		const models: ImagesModel<"deepinfra-images">[] = [];
		let excluded = 0;

		for (const model of data.data ?? []) {
			if (!(model.metadata?.tags ?? []).includes("image-gen")) continue;
			if (DEEPINFRA_IMAGE_EDIT_RE.test(model.id)) {
				excluded++;
				continue;
			}
			models.push({
				id: model.id,
				name: model.id,
				api: "deepinfra-images",
				provider: "deepinfra",
				baseUrl: DEEPINFRA_BASE_URL,
				input: ["text"],
				output: ["image"],
				// DeepInfra bills image generation per image (metadata.pricing.per_image_unit),
				// which does not map to pi's token-based ImagesModel cost.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
		}

		console.log(`Fetched ${models.length} image models from DeepInfra (excluded ${excluded} image-edit models)`);
		return models;
	} catch (error) {
		console.error("Failed to fetch DeepInfra image models:", error);
		return [];
	}
}

function serializeModel(model: ImagesModel<KnownImagesApi>): string {
	return `{
			id: ${JSON.stringify(model.id)},
			name: ${JSON.stringify(model.name)},
			api: ${JSON.stringify(model.api)},
			provider: ${JSON.stringify(model.provider)},
			baseUrl: ${JSON.stringify(model.baseUrl)},
			input: ${JSON.stringify(model.input)},
			output: ${JSON.stringify(model.output)},
			cost: ${JSON.stringify(model.cost, null, 2).replace(/^/gm, "\t")}
		} satisfies ImagesModel<${JSON.stringify(model.api)}>`;
}

function generateImageModelsFile(modelsByProvider: Record<KnownImagesProvider, ImagesModel<KnownImagesApi>[]>): string {
	const providerEntries = Object.entries(modelsByProvider)
		.map(([provider, models]) => {
			// Key by id (last wins) to collapse any duplicate ids the catalog APIs return,
			// avoiding duplicate object-literal keys in the generated file.
			const byId = new Map(models.sort((a, b) => a.id.localeCompare(b.id)).map((model) => [model.id, model]));
			const modelEntries = Array.from(byId.values())
				.map((model) => `\t\t${JSON.stringify(model.id)}: ${serializeModel(model)},`)
				.join("\n");
			return `\t${JSON.stringify(provider)}: {\n${modelEntries}\n\t},`;
		})
		.join("\n");

	return `// This file is auto-generated by scripts/generate-image-models.ts
// Do not edit manually - run 'npm run generate-image-models' to update

import type { ImagesApi, ImagesModel } from "./types.ts";

export const IMAGE_MODELS = {
${providerEntries}
} as const satisfies Record<string, Record<string, ImagesModel<ImagesApi>>>;
`;
}

async function main(): Promise<void> {
	// Independent catalog fetches; each fetcher catches its own errors and returns [].
	const [openrouter, deepinfra] = await Promise.all([fetchOpenRouterImageModels(), fetchDeepInfraImageModels()]);
	// Keys are always emitted (even when empty) so provider factories can read them.
	const output = generateImageModelsFile({ openrouter, deepinfra });
	const outputPath = join(packageRoot, "src", "image-models.generated.ts");
	writeFileSync(outputPath, output, "utf-8");
	console.log(`Generated ${outputPath}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
