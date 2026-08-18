import type { ImagesModel, ProviderImages } from "../types.ts";

export const openrouterImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await import("./openrouter-images.ts")).generateImages(
			model as ImagesModel<"openrouter-images">,
			context,
			options,
		),
});
