import { minimaxVideosApi } from "../api/minimax-videos.lazy.ts";
import { MINIMAX_VIDEO_BASE_URLS, MINIMAX_VIDEO_MODELS } from "../api/minimax-videos.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import type { VideosModel } from "../types.ts";
import { createVideosProvider, type VideosProvider } from "../videos-models.ts";

export function minimaxVideosProvider(): VideosProvider {
	return createMiniMaxVideosProvider("minimax", "MiniMax", "USD");
}

function createMiniMaxVideosProvider(provider: "minimax", name: string, currency: "USD" | "CNY"): VideosProvider {
	return createVideosProvider({
		id: provider,
		name,
		auth: {
			apiKey: envApiKeyAuth("MiniMax API key", ["MINIMAX_API_KEY"]),
		},
		models: createMiniMaxVideoModels(provider, currency),
		api: minimaxVideosApi(),
	});
}

export function createMiniMaxVideoModels(provider: "minimax" | "minimax-cn", currency: "USD" | "CNY") {
	const pricing =
		currency === "USD"
			? { outputVideo: 0.13, inputReferenceVideo: 0.02, inputReferenceAudio: 0, additionalReferenceImage: 0.03 }
			: { outputVideo: 0.8, inputReferenceVideo: 0.8, inputReferenceAudio: 0, additionalReferenceImage: 0.2 };
	const v2Models: VideosModel<"minimax-videos">[] = MINIMAX_VIDEO_MODELS.v2.map((id) => ({
		id,
		name: id,
		api: "minimax-videos",
		provider,
		baseUrl: MINIMAX_VIDEO_BASE_URLS[provider].v2,
		apiVersion: "v2",
		input: ["text", "image", "video", "audio"],
		output: ["video", "audio"],
		resolutions: ["2K"],
		durationSeconds: { min: 4, max: 15, integer: true },
		cost: pricing,
	}));
	const v1Models: VideosModel<"minimax-videos">[] = MINIMAX_VIDEO_MODELS.v1.map((id) => ({
		id,
		name: id,
		api: "minimax-videos",
		provider,
		baseUrl: MINIMAX_VIDEO_BASE_URLS[provider].v1,
		apiVersion: "v1",
		input: ["text", "image"],
		output: ["video"],
		resolutions: ["768P", "1080P"],
		durationSeconds: { min: 1, max: 10, integer: true },
		cost: pricing,
	}));
	return [...v2Models, ...v1Models];
}
