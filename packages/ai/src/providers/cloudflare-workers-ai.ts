import { cloudflareWorkersAISystemOneApi } from "../api/cloudflare-workers-ai-system-one.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { cloudflareWorkersAIAuth } from "./cloudflare-auth.ts";
import { cloudflareClassifier, cloudflareStreams } from "./cloudflare-stream.ts";
import {
	CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS,
	CLOUDFLARE_WORKERS_AI_MODELS,
} from "./cloudflare-workers-ai.models.ts";

export function cloudflareWorkersAIProvider(): Provider<"openai-completions"> {
	return createProvider<"openai-completions">({
		id: "cloudflare-workers-ai",
		name: "Cloudflare Workers AI",
		auth: { apiKey: cloudflareWorkersAIAuth() },
		models: [
			...Object.values(CLOUDFLARE_WORKERS_AI_MODELS),
			...Object.values(CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS),
		],
		api: cloudflareStreams(openAICompletionsApi()),
		classifiers: {
			"cloudflare-workers-ai-system-one": cloudflareClassifier(cloudflareWorkersAISystemOneApi()),
		},
	});
}
