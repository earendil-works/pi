// The Harness's model access through the models plugin's configuration (`HarnessConfig`'s "default"), read at each use.
// The configuration can be withdrawn while the Harness runs: the models plugin's object owns a native (its resources),
// so a restart of it (a reload of the plugin, a failure and its retry) withdraws its contribution until its successor
// opened its resources again, which takes a while on a slow machine. A model call made meanwhile waits for the
// configuration (bounded by the call's abort signal and `CONFIGURATION_WAIT_MS`) instead of failing the run; a lookup
// (synchronous: `getModel`, `getModels`) reads the last configuration seen, whose catalogs stay in memory.

import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai/utils/event-stream";

/** How long a model call waits for a withdrawn configuration before it fails: 2 minutes. */
export const CONFIGURATION_WAIT_MS = 120_000;

/** Where the Harness's models come from. */
export type ModelSource = {
	/** The configuration's models now; undefined while it is withdrawn. */
	readonly current: () => Models | undefined;
	/** Resolves with the configuration's models once it is there again; rejects when `signal` aborts first. */
	readonly present: (signal: AbortSignal) => Promise<Models>;
	/** Says why there is none (logged once per withdrawal): the registry's state and the worker's plugin load. */
	readonly diagnose: () => string;
};

/**
 * `Models` over `source`: each member read from the configuration now. While it is withdrawn, the streaming and promised
 * calls wait for it (each as the call itself, with its arguments) and the lookups read the last configuration seen.
 */
export function harnessModels(source: ModelSource, waitMs = CONFIGURATION_WAIT_MS): Models {
	let last: Models | undefined;
	/** Logs a withdrawal once, and its end. */
	let withdrawnSince: number | undefined;
	const now = (): Models | undefined => {
		const models = source.current();
		if (models !== undefined) {
			if (withdrawnSince !== undefined) {
				console.error(`p2 models: model configuration back after ${Date.now() - withdrawnSince} ms`);
				withdrawnSince = undefined;
			}
			last = models;
			return models;
		}
		if (withdrawnSince === undefined) {
			withdrawnSince = Date.now();
			console.error(
				`p2 models: no model configuration installed (models plugin), model calls wait for it: ${source.diagnose()}`,
			);
		}
		return undefined;
	};
	const ready = async (signal: AbortSignal | undefined): Promise<Models> => {
		const models = now();
		if (models !== undefined) return models;
		const timeout = AbortSignal.timeout(waitMs);
		try {
			const waited = await source.present(signal === undefined ? timeout : AbortSignal.any([signal, timeout]));
			now();
			return waited;
		} catch (error) {
			if (signal?.aborted) throw signal.reason;
			throw new Error(
				`No model configuration installed (models plugin) for ${Math.round(waitMs / 1000)} s: ${source.diagnose()}`,
				{ cause: error },
			);
		}
	};
	return new Proxy({} as Models, {
		get: (_target, key) => {
			const models = now();
			if (models !== undefined) {
				const value: unknown = Reflect.get(models, key, models);
				return typeof value === "function" ? value.bind(models) : value;
			}
			if (typeof key === "string" && STREAMED.has(key))
				return (model: Model<Api>, input: unknown, options?: { readonly signal?: AbortSignal }) =>
					waitingStream(model, options?.signal, ready(options?.signal), (later) =>
						callOn(later, key, [model, input, options]),
					);
			if (typeof key === "string" && PROMISED.has(key))
				return async (...args: unknown[]) => callOn(await ready(signalIn(args)), key, args);
			if (last === undefined)
				throw new Error(`No model configuration installed (models plugin): ${source.diagnose()}`);
			const value: unknown = Reflect.get(last, key, last);
			return typeof value === "function" ? value.bind(last) : value;
		},
	});
}

/** The members that return a response stream at once: a waiting one stands in for it. */
const STREAMED: ReadonlySet<string> = new Set(["stream", "streamSimple", "streamDeferred"]);

/** The members that return a promise: they wait, then call. */
const PROMISED: ReadonlySet<string> = new Set([
	"complete",
	"completeSimple",
	"fetchDeferred",
	"cancelDeferred",
	"refresh",
]);

/** Calls member `key` of `models` with `args`. */
function callOn<T>(models: Models, key: string, args: readonly unknown[]): T {
	// Only members of `STREAMED` and `PROMISED` reach here, each a method of `Models` taking these arguments.
	const member = Reflect.get(models, key, models) as (...args: unknown[]) => T;
	return member.apply(models, [...args]);
}

/** The abort signal of a call's options (its last argument), if any. */
function signalIn(args: readonly unknown[]): AbortSignal | undefined {
	const options = args.at(-1);
	// The options object of a `Models` call is untyped here (one helper for several members).
	return options !== null && typeof options === "object" && "signal" in options
		? (options as { readonly signal?: AbortSignal }).signal
		: undefined;
}

/**
 * A response stream that waits for `models`, then forwards `start(models)`'s events; a configuration that does not come
 * back (or an abort) ends it with an error event, as pi-ai ends a stream whose setup failed.
 */
function waitingStream(
	model: Model<Api>,
	signal: AbortSignal | undefined,
	models: Promise<Models>,
	start: (models: Models) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const startedAt = Date.now();
	const outer = createAssistantMessageEventStream();
	models
		.then(async (ready) => {
			const inner = start(ready);
			for await (const event of inner) outer.push(event);
			outer.end(await inner.result());
		})
		.catch((error: unknown) => {
			const message = failedMessage(model, error, startedAt, signal?.aborted ? "aborted" : "error");
			const event: AssistantMessageEvent = { type: "error", reason: message.stopReason, error: message };
			outer.push(event);
			outer.end(message);
		});
	return outer;
}

/** The terminal message of a response that never started (pi-ai's form for a failed setup). */
function failedMessage(
	model: Model<Api>,
	error: unknown,
	timestamp: number,
	stopReason: "aborted" | "error",
): AssistantMessage & { readonly stopReason: "aborted" | "error" } {
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
		stopReason,
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp,
	};
}
