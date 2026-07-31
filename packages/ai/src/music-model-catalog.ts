import type { KnownMusicProvider, MusicApi, MusicModel, MusicRegion } from "./types.ts";

export const DEFAULT_MUSIC_MODEL_ID = "music-3.0";

const MUSIC_MODEL_IDS = ["music-3.0", "music-2.6", "music-3.0-free", "music-2.6-free"] as const;
const MUSIC_OUTPUT_FORMATS = ["url", "hex"] as const;
const MUSIC_AUDIO_FORMATS = ["mp3", "wav", "pcm"] as const;
const MUSIC_URL_TTL_HOURS = 24;

type MusicModelId = (typeof MUSIC_MODEL_IDS)[number];
type MusicCatalogForProvider<TProvider extends KnownMusicProvider> = {
	[TModelId in MusicModelId]: MusicModel<"minimax-music"> & { id: TModelId; provider: TProvider };
};

function createMusicCatalog<TProvider extends KnownMusicProvider>(
	provider: TProvider,
	baseUrl: string,
	region: MusicRegion,
): MusicCatalogForProvider<TProvider> {
	return Object.fromEntries(
		MUSIC_MODEL_IDS.map((id) => [
			id,
			{
				id,
				name: id,
				api: "minimax-music" as const,
				provider,
				baseUrl,
				region,
				outputFormats: MUSIC_OUTPUT_FORMATS,
				audioFormats: MUSIC_AUDIO_FORMATS,
				urlTtlHours: MUSIC_URL_TTL_HOURS,
				regionalFields: region === "cn_zh" ? (["aigc_watermark"] as const) : [],
			},
		]),
	) as unknown as MusicCatalogForProvider<TProvider>;
}

export const MUSIC_MODELS = {
	minimax: createMusicCatalog("minimax", "https://api.minimax.io/v1/music_generation", "global_en"),
	"minimax-cn": createMusicCatalog("minimax-cn", "https://api.minimaxi.com/v1/music_generation", "cn_zh"),
} as const;

type MusicModelApi<
	TProvider extends KnownMusicProvider,
	TModelId extends keyof (typeof MUSIC_MODELS)[TProvider],
> = (typeof MUSIC_MODELS)[TProvider][TModelId] extends { api: infer TApi }
	? TApi extends MusicApi
		? TApi
		: never
	: never;

export function getMusicModel<
	TProvider extends KnownMusicProvider,
	TModelId extends keyof (typeof MUSIC_MODELS)[TProvider],
>(provider: TProvider, modelId: TModelId): MusicModel<MusicModelApi<TProvider, TModelId>> {
	return MUSIC_MODELS[provider][modelId] as MusicModel<MusicModelApi<TProvider, TModelId>>;
}

export function getMusicProviders(): KnownMusicProvider[] {
	return Object.keys(MUSIC_MODELS) as KnownMusicProvider[];
}

export function getMusicModels<TProvider extends KnownMusicProvider>(
	provider: TProvider,
): MusicModel<MusicModelApi<TProvider, keyof (typeof MUSIC_MODELS)[TProvider]>>[] {
	return Object.values(MUSIC_MODELS[provider]) as MusicModel<
		MusicModelApi<TProvider, keyof (typeof MUSIC_MODELS)[TProvider]>
	>[];
}
