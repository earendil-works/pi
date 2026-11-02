import { defineProvider, modelsDevModels } from "../define.ts";

export default defineProvider({
	id: "cerebras",
	models: (ctx) =>
		modelsDevModels(ctx, "cerebras", { api: "openai-completions", baseUrl: "https://api.cerebras.ai/v1" }),
	compat: { "openai-completions": { supportsStore: false, supportsDeveloperRole: false } },
});
