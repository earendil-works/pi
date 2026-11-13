import type { ProviderImages } from "../types.ts";

export const antigravityImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await import("./antigravity-images.ts")).generateImages(model, context, options),
});
