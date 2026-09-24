import "./providers/images/register-builtins.ts";

import { getImagesApiProvider } from "./images-api-registry.ts";
import type { AssistantImages, ImageApi, ImageModel, ImagesContext, ProviderImagesOptions } from "./types.ts";

function resolveImagesApiProvider(api: ImageApi) {
	const provider = getImagesApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

/**
 * Global image generation dispatched on `model.api` through the images api
 * registry. Auth must be passed explicitly via `options.apiKey`; prefer
 * `Models.generateImages()`, which resolves provider auth.
 */
export async function generateImages(
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ProviderImagesOptions,
): Promise<AssistantImages> {
	const provider = resolveImagesApiProvider(model.api);
	return provider.generateImages(model, context, options);
}
