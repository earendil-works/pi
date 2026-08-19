import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { SHENG_SUAN_YUN_MODELS } from "./sheng-suan-yun.models.ts";

export function shengSuanYunProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "sheng-suan-yun",
		name: "Sheng Suan Yun",
		baseUrl: "https://router.shengsuanyun.com/api",
		auth: { apiKey: envApiKeyAuth("ShengSuanYun API key", ["SHENG_SUAN_YUN_API_KEY"]) },
		models: Object.values(SHENG_SUAN_YUN_MODELS),
		api: anthropicMessagesApi(),
	});
}
