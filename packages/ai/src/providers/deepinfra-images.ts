import { deepinfraImagesApi } from "../api/deepinfra-images.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { IMAGE_MODELS } from "../image-models.generated.ts";
import { createImagesProvider, type ImagesProvider } from "../images-models.ts";

export function deepinfraImagesProvider(): ImagesProvider {
	return createImagesProvider({
		id: "deepinfra",
		name: "DeepInfra",
		auth: { apiKey: envApiKeyAuth("DeepInfra API key", ["DEEPINFRA_API_KEY"]) },
		models: Object.values(IMAGE_MODELS.deepinfra),
		api: deepinfraImagesApi(),
	});
}
