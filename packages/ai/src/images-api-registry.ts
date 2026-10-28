import type { AssistantImages, ImageApi, ImageModel, ImagesContext, ImagesFunction, ImagesOptions } from "./types.ts";

export type ImagesApiFunction = (
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => Promise<AssistantImages>;

export interface ImagesApiProvider<TApi extends ImageApi = ImageApi, TOptions extends ImagesOptions = ImagesOptions> {
	api: TApi;
	generateImages: ImagesFunction<TOptions>;
}

interface ImagesApiProviderInternal {
	api: ImageApi;
	generateImages: ImagesApiFunction;
}

type RegisteredImagesApiProvider = {
	provider: ImagesApiProviderInternal;
	sourceId?: string;
};

const imagesApiProviderRegistry = new Map<string, RegisteredImagesApiProvider>();

function wrapGenerateImages<TOptions extends ImagesOptions>(
	api: ImageApi,
	generateImages: ImagesFunction<TOptions>,
): ImagesApiFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return generateImages(model, context, options as TOptions);
	};
}

export function registerImagesApiProvider<TApi extends ImageApi, TOptions extends ImagesOptions>(
	provider: ImagesApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	imagesApiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			generateImages: wrapGenerateImages(provider.api, provider.generateImages),
		},
		sourceId,
	});
}

export function getImagesApiProvider(api: ImageApi): ImagesApiProviderInternal | undefined {
	return imagesApiProviderRegistry.get(api)?.provider;
}
