import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MINIMAX_CN_MODELS } from "./minimax-cn.models.ts";

export function minimaxCnProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "minimax-cn",
		name: "MiniMax CN",
		baseUrl: "https://api.minimaxi.com/anthropic",
		auth: { apiKey: envApiKeyAuth("MiniMax CN API key", ["MINIMAX_CN_API_KEY"]) },
		models: Object.values(MINIMAX_CN_MODELS),
		api: anthropicMessagesApi(),
	});
}
