import type { KnownSpeechProvider, SpeechModel } from "./types.ts";

export const SPEECH_MODEL_IDS = [
	"speech-2.8-hd",
	"speech-2.8-turbo",
	"speech-2.6-hd",
	"speech-2.6-turbo",
	"speech-02-hd",
	"speech-02-turbo",
	"speech-01-hd",
	"speech-01-turbo",
] as const;

export type SpeechModelId = (typeof SPEECH_MODEL_IDS)[number];

function buildModels(
	provider: KnownSpeechProvider,
	baseUrl: string,
): Record<SpeechModelId, SpeechModel<"minimax-speech">> {
	const models = {} as Record<SpeechModelId, SpeechModel<"minimax-speech">>;
	for (const id of SPEECH_MODEL_IDS) {
		models[id] = {
			id,
			name: id,
			api: "minimax-speech",
			provider,
			baseUrl,
			audioFormats: ["mp3", "wav", "flac", "pcm"],
		};
	}
	return models;
}

export const SPEECH_MODELS: Record<KnownSpeechProvider, Record<SpeechModelId, SpeechModel<"minimax-speech">>> = {
	minimax: buildModels("minimax", "https://api.minimax.io/v1/t2a_v2"),
	"minimax-cn": buildModels("minimax-cn", "https://api.minimaxi.com/v1/t2a_v2"),
};

export function getSpeechModel(provider: KnownSpeechProvider, modelId: SpeechModelId): SpeechModel<"minimax-speech"> {
	return SPEECH_MODELS[provider][modelId];
}

export function getSpeechProviders(): KnownSpeechProvider[] {
	return Object.keys(SPEECH_MODELS) as KnownSpeechProvider[];
}

export function getSpeechModels(provider: KnownSpeechProvider): SpeechModel<"minimax-speech">[] {
	return Object.values(SPEECH_MODELS[provider]);
}
