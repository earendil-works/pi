import { IMAGE_MODELS } from "./models.generated.ts";
import type { ImageApi, ImageModel } from "./types.ts";

/**
 * Compat reads of the generated catalog restricted to image models. New code
 * uses `Models.getModelOfType("image", ...)` or `getBuiltinImageModel()` from `providers/all`.
 */

type Catalog = typeof IMAGE_MODELS;
type ImageModelIds<TProvider extends keyof Catalog> = keyof Catalog[TProvider];

/** Built-in providers with at least one image model in the generated catalog. */
export type BuiltinImageProvider = {
	[TProvider in keyof Catalog]: [ImageModelIds<TProvider>] extends [never] ? never : TProvider;
}[keyof Catalog];

type BuiltinImageModel<
	TProvider extends BuiltinImageProvider,
	TModelId extends ImageModelIds<TProvider>,
> = Catalog[TProvider][TModelId] extends ImageModel<infer TApi extends ImageApi> ? ImageModel<TApi> : never;

const imageModelsByProvider = new Map<string, Map<string, ImageModel<ImageApi>>>();
for (const [provider, models] of Object.entries(IMAGE_MODELS)) {
	const imageModels = new Map<string, ImageModel<ImageApi>>();
	for (const model of Object.values(models as Record<string, ImageModel<ImageApi>>)) {
		imageModels.set(model.id, model);
	}
	if (imageModels.size > 0) imageModelsByProvider.set(provider, imageModels);
}

/** @deprecated Static catalog read. Use `getBuiltinImageModel` from "@earendil-works/pi-ai/providers/all" or `Models.getModelOfType("image", ...)`. */
export function getImageModel<TProvider extends BuiltinImageProvider, TModelId extends ImageModelIds<TProvider>>(
	provider: TProvider,
	modelId: TModelId,
): BuiltinImageModel<TProvider, TModelId> {
	return imageModelsByProvider.get(provider)?.get(modelId as string) as BuiltinImageModel<TProvider, TModelId>;
}

/** @deprecated Static catalog read. Use `Models.getProviders()`. */
export function getImageProviders(): BuiltinImageProvider[] {
	return Array.from(imageModelsByProvider.keys()) as BuiltinImageProvider[];
}

/** @deprecated Static catalog read. Use `getBuiltinImageModels` from "@earendil-works/pi-ai/providers/all" or `Models.getModelsOfType("image")`. */
export function getImageModels<TProvider extends BuiltinImageProvider>(
	provider: TProvider,
): BuiltinImageModel<TProvider, ImageModelIds<TProvider>>[] {
	const models = imageModelsByProvider.get(provider);
	return models ? (Array.from(models.values()) as BuiltinImageModel<TProvider, ImageModelIds<TProvider>>[]) : [];
}
