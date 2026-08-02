import { minimaxVideosApi } from "../api/minimax-videos.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createVideosProvider, type VideosProvider } from "../videos-models.ts";
import { createMiniMaxVideoModels } from "./minimax-videos.ts";

export function minimaxCnVideosProvider(): VideosProvider {
	return createVideosProvider({
		id: "minimax-cn",
		name: "MiniMax CN",
		auth: {
			apiKey: envApiKeyAuth("MiniMax API key", ["MINIMAX_API_KEY"]),
		},
		models: createMiniMaxVideoModels("minimax-cn", "CNY"),
		api: minimaxVideosApi(),
	});
}
