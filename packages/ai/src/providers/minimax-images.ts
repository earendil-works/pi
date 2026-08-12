import { generateImages, type MiniMaxImagesOptions } from "../api/minimax-images.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { IMAGE_MODELS } from "../image-models.generated.ts";
import { createImagesProvider, type ImagesProvider } from "../images-models.ts";
import type { ImagesModel, ProviderImages } from "../types.ts";

const minimaxImagesApi = (): ProviderImages => ({
	generateImages: (model, context, options) =>
		generateImages(model as ImagesModel<"minimax-images">, context, options as MiniMaxImagesOptions),
});

export function minimaxImagesProvider(): ImagesProvider {
	return createImagesProvider({
		id: "minimax",
		name: "MiniMax",
		auth: { apiKey: envApiKeyAuth("MiniMax API key", ["MINIMAX_API_KEY"]) },
		models: Object.values(IMAGE_MODELS.minimax),
		api: minimaxImagesApi(),
	});
}

export function minimaxCnImagesProvider(): ImagesProvider {
	return createImagesProvider({
		id: "minimax-cn",
		name: "MiniMax CN",
		auth: { apiKey: envApiKeyAuth("MiniMax CN API key", ["MINIMAX_CN_API_KEY"]) },
		models: Object.values(IMAGE_MODELS["minimax-cn"]),
		api: minimaxImagesApi(),
	});
}
