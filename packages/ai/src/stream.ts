import "./providers/register-builtins.js";

import { getApiProvider } from "./api-registry.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.js";
import { AssistantMessageEventStream as AssistantMessageEventStreamClass } from "./utils/event-stream.js";
import { optimizeContextImages } from "./utils/optimize-context-images.js";

export { getEnvApiKey } from "./env-api-keys.js";

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	if (!options?.optimizeImage) {
		return provider.stream(model, context, options as StreamOptions);
	}
	return wrapWithImageOptimization(context, options as StreamOptions, (ctx) =>
		provider.stream(model, ctx, options as StreamOptions),
	);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	if (!options?.optimizeImage) {
		return provider.streamSimple(model, context, options);
	}
	return wrapWithImageOptimization(context, options, (ctx) => provider.streamSimple(model, ctx, options));
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}

/**
 * Wrap a provider stream call with image optimization.
 * Optimizes images in the context before delegating to the provider,
 * then forwards all events from the inner stream to the outer stream.
 */
function wrapWithImageOptimization(
	context: Context,
	options: StreamOptions,
	createInnerStream: (optimizedContext: Context) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStreamClass();

	queueMicrotask(async () => {
		try {
			const optimizedContext = await optimizeContextImages(context, options);
			const inner = createInnerStream(optimizedContext);
			for await (const event of inner) {
				outer.push(event);
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const errorMsg: AssistantMessage = {
				role: "assistant",
				content: [],
				api: "" as Api,
				provider: "",
				model: "",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: `Image optimization failed: ${errorMessage}`,
				timestamp: Date.now(),
			};
			outer.push({
				type: "error",
				reason: "error",
				error: errorMsg,
			});
			outer.end(errorMsg);
		}
	});

	return outer;
}
