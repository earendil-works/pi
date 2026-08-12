import type { ProviderSpeech, SpeechModel } from "../types.ts";

export const minimaxSpeechApi = (): ProviderSpeech => ({
	generateSpeech: async (model, context, options) =>
		(await import("./minimax-speech.ts")).generateSpeech(model as SpeechModel<"minimax-speech">, context, options),
});
