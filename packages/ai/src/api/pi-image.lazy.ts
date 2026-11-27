import type { ProviderImages } from "../types.ts";

export const piImageApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await import("./pi-image.ts")).generateImages(model, context, options),
});
