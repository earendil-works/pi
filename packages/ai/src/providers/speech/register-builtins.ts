import type { generateSpeech as generateMinimaxSpeechFunction } from "../../api/minimax-speech.ts";
import { registerSpeechApiProvider } from "../../speech-api-registry.ts";
import type { AssistantSpeech, SpeechContext, SpeechFunction, SpeechModel, SpeechOptions } from "../../types.ts";

interface MinimaxSpeechProviderModule {
	generateSpeech: typeof generateMinimaxSpeechFunction;
}

let minimaxSpeechProviderModulePromise: Promise<MinimaxSpeechProviderModule> | undefined;

function loadMinimaxSpeechProviderModule(): Promise<MinimaxSpeechProviderModule> {
	minimaxSpeechProviderModulePromise ??= import("../../api/minimax-speech.ts").then(
		(module) => module as MinimaxSpeechProviderModule,
	);
	return minimaxSpeechProviderModulePromise;
}

export const generateSpeechMinimax: SpeechFunction<"minimax-speech", SpeechOptions> = async (
	model: SpeechModel<"minimax-speech">,
	context: SpeechContext,
	options?: SpeechOptions,
) => {
	try {
		const module = await loadMinimaxSpeechProviderModule();
		return await module.generateSpeech(model, context, options);
	} catch (error) {
		return {
			api: model.api,
			provider: model.provider,
			model: model.id,
			output: [],
			stopReason: options?.signal?.aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies AssistantSpeech;
	}
};

export function registerBuiltInSpeechApiProviders(): void {
	registerSpeechApiProvider({
		api: "minimax-speech",
		generateSpeech: generateSpeechMinimax,
	});
}

registerBuiltInSpeechApiProviders();
