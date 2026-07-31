import type { ImagesModel, ProviderImages } from "../types.ts";
import type { MiniMaxImagesOptions } from "./minimax-images.ts";

export const minimaxImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await import("./minimax-images.ts")).generateImages(
			model as ImagesModel<"minimax-images">,
			context,
			options as MiniMaxImagesOptions,
		),
});
