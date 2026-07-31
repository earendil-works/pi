import { generateMusic } from "../api/minimax-music.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { MUSIC_MODELS } from "../music-model-catalog.ts";
import { createMusicProvider, type MusicProvider } from "../music-models.ts";

export function minimaxMusicProvider(): MusicProvider {
	return createMusicProvider({
		id: "minimax",
		name: "MiniMax",
		auth: { apiKey: envApiKeyAuth("MiniMax API key", ["MINIMAX_API_KEY"]) },
		models: Object.values(MUSIC_MODELS.minimax),
		api: { generateMusic },
	});
}
