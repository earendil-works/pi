import { generateMusic } from "../../api/minimax-music.ts";
import { registerMusicApiProvider } from "../../music-api-registry.ts";

export function registerBuiltInMusicApiProviders(): void {
	registerMusicApiProvider({
		api: "minimax-music",
		generateMusic,
	});
}

registerBuiltInMusicApiProviders();
