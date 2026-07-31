import type { generateImages as generateImagesMiniMaxFunction } from "../../api/minimax-images.ts";
import type { generateImages as generateImagesOpenRouterFunction } from "../../api/openrouter-images.ts";
import { registerImagesApiProvider } from "../../images-api-registry.ts";
import type { AssistantImages, ImagesApi, ImagesFunction, ImagesModel, ImagesOptions } from "../../types.ts";

interface OpenRouterImagesProviderModule {
	generateImages: typeof generateImagesOpenRouterFunction;
}

interface MiniMaxImagesProviderModule {
	generateImages: typeof generateImagesMiniMaxFunction;
}

function createLazyLoadErrorImages<TApi extends ImagesApi>(model: ImagesModel<TApi>, error: unknown): AssistantImages {
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

function lazyGenerateImages<TApi extends ImagesApi, TOptions extends ImagesOptions>(
	load: () => Promise<{ generateImages: ImagesFunction<TApi, TOptions> }>,
): ImagesFunction<TApi, TOptions> {
	let modulePromise: Promise<{ generateImages: ImagesFunction<TApi, TOptions> }> | undefined;
	return async (model, context, options) => {
		try {
			modulePromise ||= load();
			return await (await modulePromise).generateImages(model, context, options);
		} catch (error) {
			return createLazyLoadErrorImages(model, error);
		}
	};
}

export const generateImagesOpenRouter = lazyGenerateImages<"openrouter-images", ImagesOptions>(
	() => import("../../api/openrouter-images.ts") as Promise<OpenRouterImagesProviderModule>,
);

export const generateImagesMiniMax = lazyGenerateImages(
	() => import("../../api/minimax-images.ts") as Promise<MiniMaxImagesProviderModule>,
);

export function registerBuiltInImagesApiProviders(): void {
	registerImagesApiProvider({
		api: "openrouter-images",
		generateImages: generateImagesOpenRouter,
	});
	registerImagesApiProvider({
		api: "minimax-images",
		generateImages: generateImagesMiniMax,
	});
}

registerBuiltInImagesApiProviders();
