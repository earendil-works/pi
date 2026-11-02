import { defineProvider, mergeThinking, modelsDevModels } from "../define.ts";

export default defineProvider({
	id: "groq",
	models: (ctx) =>
		modelsDevModels(ctx, "groq", { api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1" }),
	compat: { "openai-completions": { supportsStrictMode: true } },
	finalize: (model) => {
		if (model.id === "qwen/qwen3.6-27b") {
			mergeThinking(model, { minimal: null, low: null, medium: null, high: "default" });
		}
	},
});
