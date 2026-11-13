import type { generateImages as generateImagesAntigravityFunction } from "../../api/antigravity-images.ts";
import type { generateImages as generateImagesOpenRouterFunction } from "../../api/openrouter-images.ts";
import { registerImagesApiProvider } from "../../images-api-registry.ts";
import type {
	AssistantImages,
	ImageApi,
	ImageModel,
	ImagesContext,
	ImagesFunction,
	ImagesOptions,
} from "../../types.ts";

interface AntigravityImagesProviderModule {
	generateImages: typeof generateImagesAntigravityFunction;
}

interface OpenRouterImagesProviderModule {
	generateImages: typeof generateImagesOpenRouterFunction;
}

let antigravityImagesProviderModulePromise: Promise<AntigravityImagesProviderModule> | undefined;
let openRouterImagesProviderModulePromise: Promise<OpenRouterImagesProviderModule> | undefined;

function createLazyLoadErrorImages(model: ImageModel<ImageApi>, error: unknown): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function loadAntigravityImagesProviderModule(): Promise<AntigravityImagesProviderModule> {
	antigravityImagesProviderModulePromise ||= import("../../api/antigravity-images.ts").then(
		(module) => module as AntigravityImagesProviderModule,
	);
	return antigravityImagesProviderModulePromise;
}

export const generateImagesAntigravity: ImagesFunction<ImagesOptions> = async (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	try {
		const module = await loadAntigravityImagesProviderModule();
		return await module.generateImages(model, context, options);
	} catch (error) {
		return createLazyLoadErrorImages(model, error);
	}
};

function loadOpenRouterImagesProviderModule(): Promise<OpenRouterImagesProviderModule> {
	openRouterImagesProviderModulePromise ||= import("../../api/openrouter-images.ts").then(
		(module) => module as OpenRouterImagesProviderModule,
	);
	return openRouterImagesProviderModulePromise;
}

export const generateImagesOpenRouter: ImagesFunction<ImagesOptions> = async (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	try {
		const module = await loadOpenRouterImagesProviderModule();
		return await module.generateImages(model, context, options);
	} catch (error) {
		return createLazyLoadErrorImages(model, error);
	}
};

export function registerBuiltInImagesApiProviders(): void {
	registerImagesApiProvider({ api: "antigravity-images", generateImages: generateImagesAntigravity });
	registerImagesApiProvider({
		api: "openrouter-images",
		generateImages: generateImagesOpenRouter,
	});
}

registerBuiltInImagesApiProviders();
