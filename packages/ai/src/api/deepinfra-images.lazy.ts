import type { ImagesModel, ProviderImages } from "../types.ts";

export const deepinfraImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await import("./deepinfra-images.ts")).generateImages(
			model as ImagesModel<"deepinfra-images">,
			context,
			options,
		),
});
