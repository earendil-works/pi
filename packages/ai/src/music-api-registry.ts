import type { AssistantMusic, MusicApi, MusicContext, MusicFunction, MusicModel, MusicOptions } from "./types.ts";

export type MusicApiFunction = (
	model: MusicModel<MusicApi>,
	context: MusicContext,
	options?: MusicOptions,
) => Promise<AssistantMusic>;

export interface MusicApiProvider<TApi extends MusicApi = MusicApi, TOptions extends MusicOptions = MusicOptions> {
	api: TApi;
	generateMusic: MusicFunction<TApi, TOptions>;
}

interface MusicApiProviderInternal {
	api: MusicApi;
	generateMusic: MusicApiFunction;
}

const musicApiProviderRegistry = new Map<string, MusicApiProviderInternal>();

function wrapGenerateMusic<TApi extends MusicApi, TOptions extends MusicOptions>(
	api: TApi,
	generateMusic: MusicFunction<TApi, TOptions>,
): MusicApiFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return generateMusic(model as MusicModel<TApi>, context, options as TOptions);
	};
}

export function registerMusicApiProvider<TApi extends MusicApi, TOptions extends MusicOptions>(
	provider: MusicApiProvider<TApi, TOptions>,
): void {
	musicApiProviderRegistry.set(provider.api, {
		api: provider.api,
		generateMusic: wrapGenerateMusic(provider.api, provider.generateMusic),
	});
}

export function getMusicApiProvider(api: MusicApi): MusicApiProviderInternal | undefined {
	return musicApiProviderRegistry.get(api);
}
