import { defineProvider, modelsDevModels } from "../define.ts";

export default defineProvider({
	id: "groq",
	models: (ctx) =>
		modelsDevModels(ctx, "groq", {
			api: "openai-completions",
			baseUrl: "https://api.groq.com/openai/v1",
			// models.dev has marked Groq models deprecated only after Groq shut them down, then deletes
			// them weeks later, e.g. llama-3.3-70b-versatile: shut down 2026-08-16, marked 2026-10-21.
			skipDeprecated: true,
		}),
	compat: { "openai-completions": { supportsStrictMode: true } },
});
