import { generateMusic } from "../api/minimax-music.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { MUSIC_MODELS } from "../music-model-catalog.ts";
import { createMusicProvider, type MusicProvider } from "../music-models.ts";

export function minimaxCnMusicProvider(): MusicProvider {
	return createMusicProvider({
		id: "minimax-cn",
		name: "MiniMax CN",
		auth: { apiKey: envApiKeyAuth("MiniMax CN API key", ["MINIMAX_CN_API_KEY"]) },
		models: Object.values(MUSIC_MODELS["minimax-cn"]),
		api: { generateMusic },
	});
}
