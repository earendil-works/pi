import type { AssistantVideos, VideosApi, VideosContext, VideosFunction, VideosModel, VideosOptions } from "./types.ts";

export type VideosApiFunction = (
	model: VideosModel<VideosApi>,
	context: VideosContext,
	options?: VideosOptions,
) => Promise<AssistantVideos>;

export type VideoTaskApiFunction = (
	model: VideosModel<VideosApi>,
	taskOrFileId: string,
	options?: VideosOptions,
) => Promise<AssistantVideos>;

export interface VideosApiProvider<TApi extends VideosApi = VideosApi, TOptions extends VideosOptions = VideosOptions> {
	api: TApi;
	generateVideos: VideosFunction<TApi, TOptions>;
	queryVideoGeneration?: (model: VideosModel<TApi>, taskId: string, options?: TOptions) => Promise<AssistantVideos>;
	downloadVideo?: (model: VideosModel<TApi>, fileId: string, options?: TOptions) => Promise<AssistantVideos>;
}

interface VideosApiProviderInternal {
	api: VideosApi;
	generateVideos: VideosApiFunction;
	queryVideoGeneration?: VideoTaskApiFunction;
	downloadVideo?: VideoTaskApiFunction;
}

type RegisteredVideosApiProvider = {
	provider: VideosApiProviderInternal;
	sourceId?: string;
};

const videosApiProviderRegistry = new Map<string, RegisteredVideosApiProvider>();

function wrapGenerateVideos<TApi extends VideosApi, TOptions extends VideosOptions>(
	api: TApi,
	generateVideos: VideosFunction<TApi, TOptions>,
): VideosApiFunction {
	return (model, context, options) => {
		if (model.api !== api) throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		return generateVideos(model as VideosModel<TApi>, context, options as TOptions);
	};
}

function wrapVideoTask<TApi extends VideosApi, TOptions extends VideosOptions>(
	api: TApi,
	fn: (model: VideosModel<TApi>, id: string, options?: TOptions) => Promise<AssistantVideos>,
): VideoTaskApiFunction {
	return (model, id, options) => {
		if (model.api !== api) throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		return fn(model as VideosModel<TApi>, id, options as TOptions);
	};
}

export function registerVideosApiProvider<TApi extends VideosApi, TOptions extends VideosOptions>(
	provider: VideosApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	videosApiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			generateVideos: wrapGenerateVideos(provider.api, provider.generateVideos),
			queryVideoGeneration: provider.queryVideoGeneration
				? wrapVideoTask(provider.api, provider.queryVideoGeneration)
				: undefined,
			downloadVideo: provider.downloadVideo ? wrapVideoTask(provider.api, provider.downloadVideo) : undefined,
		},
		sourceId,
	});
}

export function getVideosApiProvider(api: VideosApi): VideosApiProviderInternal | undefined {
	return videosApiProviderRegistry.get(api)?.provider;
}
