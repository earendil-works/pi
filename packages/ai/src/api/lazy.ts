import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

function createSetupErrorMessage(model: Model<Api>, error: unknown, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp,
	};
}

function hasResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

/** Synchronous, read-only observation of the stream's existing forwarding path. */
export interface LazyStreamObserver {
	onEvent?(event: AssistantMessageEvent): void;
	onResult?(result: AssistantMessage | undefined): void;
}

async function forwardStream(
	target: AssistantMessageEventStream,
	source: AsyncIterable<AssistantMessageEvent>,
	observer: LazyStreamObserver | undefined,
	observeResult: (result: AssistantMessage | undefined) => void,
): Promise<void> {
	let result: AssistantMessage | undefined;
	for await (const event of source) {
		target.push(event);
		observer?.onEvent?.(event);
		if (event.type === "done") result = event.message;
		else if (event.type === "error") result = event.error;
	}
	if (hasResult(source)) result = await source.result();
	target.end(result);
	observeResult(result);
}

/**
 * Returns a stream synchronously while running async setup (auth resolution,
 * lazy module loading) behind it. Setup failures terminate the stream with an
 * error event.
 */
export function lazyStream(
	model: Model<Api>,
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
	observer?: LazyStreamObserver,
): AssistantMessageEventStream {
	const startedAt = Date.now();
	const outer = new AssistantMessageEventStream();
	let observedResult = false;
	const observeResult = (result: AssistantMessage | undefined): void => {
		if (observedResult) return;
		observedResult = true;
		observer?.onResult?.(result);
	};

	setup()
		.then((inner) => forwardStream(outer, inner, observer, observeResult))
		.catch((error) => {
			const message = createSetupErrorMessage(model, error, startedAt);
			const event: AssistantMessageEvent = { type: "error", reason: "error", error: message };
			outer.push(event);
			observer?.onEvent?.(event);
			outer.end(message);
			observeResult(message);
		});

	return outer;
}

/**
 * Wraps a dynamically imported API implementation module as `ProviderStreams`.
 * The module loads on first stream call; the host's import cache deduplicates
 * loads. Load failures terminate the returned stream with an error event.
 */
export interface LazyApiCapabilities {
	fetchDeferred?: boolean;
	cancelDeferred?: boolean;
}

export function lazyApi(load: () => Promise<ProviderStreams>, capabilities?: LazyApiCapabilities): ProviderStreams {
	const api: ProviderStreams = {
		stream: (model, context, options) =>
			lazyStream(model, async () => (await load()).stream(model, context, options)),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () => (await load()).streamSimple(model, context, options)),
	};

	if (capabilities?.fetchDeferred) {
		api.fetchDeferred = (model, handle, options) =>
			lazyStream(model, async () => {
				const implementation = await load();
				if (!implementation.fetchDeferred) throw new Error("API does not support deferred responses");
				return implementation.fetchDeferred(model, handle, options);
			});
	}
	if (capabilities?.cancelDeferred) {
		api.cancelDeferred = async (model, handle, options) => {
			const implementation = await load();
			if (!implementation.cancelDeferred) throw new Error("API cannot cancel deferred responses");
			await implementation.cancelDeferred(model, handle, options);
		};
	}

	return api;
}
