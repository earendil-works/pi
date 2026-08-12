import "./providers/speech/register-builtins.ts";

import { getSpeechApiProvider } from "./speech-api-registry.ts";
import type { AssistantSpeech, ProviderSpeechOptions, SpeechApi, SpeechContext, SpeechModel } from "./types.ts";

export async function generateSpeech<TApi extends SpeechApi>(
	model: SpeechModel<TApi>,
	context: SpeechContext,
	options?: ProviderSpeechOptions,
): Promise<AssistantSpeech> {
	const provider = getSpeechApiProvider(model.api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${model.api}`);
	}
	return provider.generateSpeech(model, context, options);
}
