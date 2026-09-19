import type { ProviderHeaders, ProviderStreams, StreamOptions } from "../types.ts";

const OPENCODE_SESSION_HEADER = "x-opencode-session";

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	const expected = name.toLowerCase();
	return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === expected);
}

function withSessionHeader<TOptions extends StreamOptions>(options: TOptions | undefined): TOptions | undefined {
	if (!options?.sessionId || hasHeader(options.headers, OPENCODE_SESSION_HEADER)) return options;
	return {
		...options,
		headers: { ...options.headers, [OPENCODE_SESSION_HEADER]: options.sessionId },
	};
}

/** Adds OpenCode's required per-conversation routing header before API dispatch. */
export function withOpenCodeSessionHeader(streams: ProviderStreams): ProviderStreams {
	return {
		...streams,
		stream: (model, context, options) => streams.stream(model, context, withSessionHeader(options)),
		streamSimple: (model, context, options) => streams.streamSimple(model, context, withSessionHeader(options)),
	};
}
