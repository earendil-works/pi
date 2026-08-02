import type { ProviderVideos, VideosModel } from "../types.ts";
import type { MiniMaxVideosOptions } from "./minimax-videos.ts";

export const minimaxVideosApi = (): ProviderVideos => ({
	generateVideos: async (model, context, options) =>
		(await import("./minimax-videos.ts")).generateVideos(
			model as VideosModel<"minimax-videos">,
			context,
			options as MiniMaxVideosOptions,
		),
	queryVideoGeneration: async (model, taskId, options) =>
		(await import("./minimax-videos.ts")).queryVideoGeneration(
			model as VideosModel<"minimax-videos">,
			taskId,
			options as MiniMaxVideosOptions,
		),
	downloadVideo: async (model, fileId, options) =>
		(await import("./minimax-videos.ts")).downloadVideo(
			model as VideosModel<"minimax-videos">,
			fileId,
			options as MiniMaxVideosOptions,
		),
});
