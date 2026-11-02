import { defineProvider, modelsDevModels } from "../define.ts";

export default defineProvider({
	id: "huggingface",
	models: (ctx) =>
		modelsDevModels(ctx, "huggingface", {
			api: "openai-completions",
			baseUrl: "https://router.huggingface.co/v1",
			compat: { supportsDeveloperRole: false },
		}),
	compat: { "openai-completions": { supportsStrictMode: true } },
});
