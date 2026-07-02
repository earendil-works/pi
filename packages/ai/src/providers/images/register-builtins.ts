import { registerImagesApiProvider } from "../../images-api-registry.ts";
import type { AssistantImages, ImagesApi, ImagesFunction, ImagesModel, ImagesOptions } from "../../types.ts";

function createLazyLoadErrorImages(model: ImagesModel<ImagesApi>, error: unknown): AssistantImages {
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

/**
 * Wrap a dynamically imported image API in a lazily-loaded `ImagesFunction`. The
 * module is imported once on first use (the host's import cache deduplicates), and a
 * failed load surfaces as an error `AssistantImages` rather than a rejection.
 */
function createLazyImagesApi<TApi extends ImagesApi>(
	load: () => Promise<{ generateImages: ImagesFunction<TApi, ImagesOptions> }>,
): ImagesFunction<TApi, ImagesOptions> {
	let modulePromise: Promise<{ generateImages: ImagesFunction<TApi, ImagesOptions> }> | undefined;
	return async (model, context, options) => {
		try {
			modulePromise ||= load();
			const module = await modulePromise;
			return await module.generateImages(model, context, options);
		} catch (error) {
			return createLazyLoadErrorImages(model, error);
		}
	};
}

export function registerBuiltInImagesApiProviders(): void {
	registerImagesApiProvider({
		api: "openrouter-images",
		generateImages: createLazyImagesApi<"openrouter-images">(() => import("../../api/openrouter-images.ts")),
	});
	registerImagesApiProvider({
		api: "deepinfra-images",
		generateImages: createLazyImagesApi<"deepinfra-images">(() => import("../../api/deepinfra-images.ts")),
	});
}

registerBuiltInImagesApiProviders();
