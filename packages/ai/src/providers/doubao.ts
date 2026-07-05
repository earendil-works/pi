import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { DOUBAO_MODELS } from "./doubao.models.ts";

export const DOUBAO_API_KEY_ENV = "ARK_API_KEY";
export const DOUBAO_MODEL_ID_ENV = "ARK_MODEL_ID";

const doubaoAuth: ApiKeyAuth = {
	name: "Doubao API key",
	login: async (callbacks) => {
		const key = await callbacks.prompt({ type: "secret", message: "Enter Doubao API key" });
		const modelId = await callbacks.prompt({ type: "text", message: "Enter Doubao model ID", placeholder: "ep-..." });
		return { type: "api_key", key, env: { [DOUBAO_MODEL_ID_ENV]: modelId } };
	},
	resolve: async ({ ctx, credential }) => {
		const key = credential?.key ?? (await ctx.env(DOUBAO_API_KEY_ENV));
		const modelId = credential?.env?.[DOUBAO_MODEL_ID_ENV] ?? (await ctx.env(DOUBAO_MODEL_ID_ENV));
		if (!key || !modelId) return undefined;
		return {
			auth: { apiKey: key },
			env: { [DOUBAO_MODEL_ID_ENV]: modelId },
			source: credential?.key ? "stored credential" : `${DOUBAO_API_KEY_ENV}, ${DOUBAO_MODEL_ID_ENV}`,
		};
	},
};

export function doubaoProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "doubao",
		name: "Doubao",
		baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
		auth: { apiKey: doubaoAuth },
		models: Object.values(DOUBAO_MODELS),
		api: openAICompletionsApi(),
	});
}
