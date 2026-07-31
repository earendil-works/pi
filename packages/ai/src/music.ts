import "./providers/music/register-builtins.ts";

import { getMusicApiProvider } from "./music-api-registry.ts";
import type { AssistantMusic, MusicApi, MusicContext, MusicModel, ProviderMusicOptions } from "./types.ts";

function resolveMusicApiProvider(api: MusicApi) {
	const provider = getMusicApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

export async function generateMusic<TApi extends MusicApi>(
	model: MusicModel<TApi>,
	context: MusicContext,
	options?: ProviderMusicOptions,
): Promise<AssistantMusic> {
	const provider = resolveMusicApiProvider(model.api);
	return provider.generateMusic(model, context, options);
}
