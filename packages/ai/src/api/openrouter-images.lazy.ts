import type { ProviderImages } from "../types.ts";

export const openrouterImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await import("./openrouter-images.ts")).generateImages(model, context, options),
});
