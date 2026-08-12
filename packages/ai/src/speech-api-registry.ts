import type { AssistantSpeech, SpeechApi, SpeechContext, SpeechFunction, SpeechModel, SpeechOptions } from "./types.ts";

export type SpeechApiFunction = (
	model: SpeechModel<SpeechApi>,
	context: SpeechContext,
	options?: SpeechOptions,
) => Promise<AssistantSpeech>;

export interface SpeechApiProvider<TApi extends SpeechApi = SpeechApi, TOptions extends SpeechOptions = SpeechOptions> {
	api: TApi;
	generateSpeech: SpeechFunction<TApi, TOptions>;
}

interface SpeechApiProviderInternal {
	api: SpeechApi;
	generateSpeech: SpeechApiFunction;
}

const speechApiProviderRegistry = new Map<string, SpeechApiProviderInternal>();

export function registerSpeechApiProvider<TApi extends SpeechApi, TOptions extends SpeechOptions>(
	provider: SpeechApiProvider<TApi, TOptions>,
): void {
	speechApiProviderRegistry.set(provider.api, {
		api: provider.api,
		generateSpeech: (model, context, options) => {
			if (model.api !== provider.api) {
				throw new Error(`Mismatched api: ${model.api} expected ${provider.api}`);
			}
			return provider.generateSpeech(model as SpeechModel<TApi>, context, options as TOptions);
		},
	});
}

export function getSpeechApiProvider(api: SpeechApi): SpeechApiProviderInternal | undefined {
	return speechApiProviderRegistry.get(api);
}
