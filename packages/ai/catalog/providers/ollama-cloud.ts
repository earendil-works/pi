import { defineProvider, modelsDevModels } from "../define.ts";
import { catalogedEffortCompat, OPENAI_COMPATIBLE_HOST_COMPAT } from "../openai-compatible.ts";

// Ollama Cloud's OpenAI-compatible endpoint does not report usage while streaming.
export default defineProvider({
	id: "ollama-cloud",
	models: (ctx) =>
		modelsDevModels(ctx, "ollama-cloud", {
			api: "openai-completions",
			baseUrl: "https://ollama.com/v1",
			map: (model, source) => ({ ...model, compat: catalogedEffortCompat(source) }),
		}),
	compat: { "openai-completions": { ...OPENAI_COMPATIBLE_HOST_COMPAT, supportsUsageInStreaming: false } },
});
