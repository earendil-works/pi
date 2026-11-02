import { defineProvider, modelsDevModels } from "../define.ts";

export default defineProvider({
	id: "meta",
	models: (ctx) => modelsDevModels(ctx, "meta", { api: "openai-responses", baseUrl: "https://api.meta.ai/v1" }),
});
