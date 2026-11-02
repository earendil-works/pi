import { CLOUDFLARE_WORKERS_AI_BASE_URL, CLOUDFLARE_WORKERS_AI_REST_BASE_URL } from "../../src/api/cloudflare.ts";
import type { ClassifierModel } from "../../src/types.ts";
import { defineProvider, modelsDevModels } from "../define.ts";

function classifier(
	id: string,
	name: string,
	input: number,
	contextWindow: number,
	imageInput: "images" | "assets",
): ClassifierModel<"cloudflare-workers-ai-system-one"> {
	return {
		type: "classifier",
		id,
		name,
		api: "cloudflare-workers-ai-system-one",
		provider: "cloudflare-workers-ai",
		baseUrl: CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
		input: ["text", "image"],
		cost: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		compat: { imageInput },
	};
}

// Workers AI has no unauthenticated catalog, so its System One models are listed here from
// Cloudflare's model pages.
const CLASSIFIER_MODELS = [
	// Cloudflare-hosted Clef decision models. They take up to four PNG, JPEG, or WebP images as data URLs.
	// Clef Omni also takes audio and video, which classifier contexts do not carry.
	// Pricing and context: https://developers.cloudflare.com/workers-ai/models/clef/,
	// https://developers.cloudflare.com/workers-ai/models/clef-flash/,
	// and https://developers.cloudflare.com/workers-ai/models/clef-omni/
	classifier("@cf/cloudflare/clef", "Clef", 0.24, 65536, "images"),
	classifier("@cf/cloudflare/clef-flash", "Clef Flash", 0.038, 24576, "images"),
	classifier("@cf/cloudflare/clef-omni", "Clef Omni", 0.15, 64000, "images"),
	// TypeSafe's Jev models take PNG and JPEG images as System One assets.
	// https://developers.cloudflare.com/ai/models/typesafe/jev/ (jev-latest)
	// and https://developers.cloudflare.com/ai/models/typesafe/jev-1.14.0/
	classifier("typesafe/jev", "Jev", 0.042, 32000, "assets"),
	classifier("typesafe/jev-1.14.0", "Jev 1.14", 0.042, 32000, "assets"),
];

export default defineProvider({
	id: "cloudflare-workers-ai",
	models: (ctx) =>
		modelsDevModels(ctx, "cloudflare-workers-ai", {
			api: "openai-completions",
			baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
			compat: { sendSessionAffinityHeaders: true },
		}),
	classifiers: () => CLASSIFIER_MODELS,
	compat: {
		"openai-completions": {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsStrictMode: true,
			supportsLongCacheRetention: false,
		},
	},
});
