import "./providers/videos/register-builtins.ts";

import type { AssistantVideos, ProviderVideosOptions, VideosApi, VideosContext, VideosModel } from "./types.ts";
import { getVideosApiProvider } from "./videos-api-registry.ts";

function resolveVideosApiProvider(api: VideosApi) {
	const provider = getVideosApiProvider(api);
	if (!provider) throw new Error(`No API provider registered for api: ${api}`);
	return provider;
}

export async function generateVideos<TApi extends VideosApi>(
	model: VideosModel<TApi>,
	context: VideosContext,
	options?: ProviderVideosOptions,
): Promise<AssistantVideos> {
	return resolveVideosApiProvider(model.api).generateVideos(model, context, options);
}

export async function queryVideoGeneration<TApi extends VideosApi>(
	model: VideosModel<TApi>,
	taskId: string,
	options?: ProviderVideosOptions,
): Promise<AssistantVideos> {
	const query = resolveVideosApiProvider(model.api).queryVideoGeneration;
	if (!query) throw new Error(`No video query provider registered for api: ${model.api}`);
	return query(model, taskId, options);
}

export async function downloadVideo<TApi extends VideosApi>(
	model: VideosModel<TApi>,
	fileId: string,
	options?: ProviderVideosOptions,
): Promise<AssistantVideos> {
	const download = resolveVideosApiProvider(model.api).downloadVideo;
	if (!download) throw new Error(`No video download provider registered for api: ${model.api}`);
	return download(model, fileId, options);
}
