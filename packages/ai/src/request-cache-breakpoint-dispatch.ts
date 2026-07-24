import type { Context, Message, ProviderStreams } from "./types.ts";
import { REQUEST_CACHE_BREAKPOINT } from "./types.ts";

const trustedRequestCacheBreakpointAdapters = new WeakSet<ProviderStreams>();

/**
 * Brand the repository-owned lazy API wrappers that implement the exhaustive
 * KnownApi marker contract. Open-ended ProviderStreams remain fail-closed.
 */
export function trustRequestCacheBreakpointAdapter(streams: ProviderStreams): ProviderStreams {
	trustedRequestCacheBreakpointAdapters.add(streams);
	return streams;
}

export function isTrustedRequestCacheBreakpointAdapter(streams: ProviderStreams): boolean {
	return trustedRequestCacheBreakpointAdapters.has(streams);
}

function stripContentBreakpoints<TBlock extends object>(blocks: TBlock[]): TBlock[] | undefined {
	let changed = false;
	const stripped = blocks.map((block) => {
		if (!Object.hasOwn(block, REQUEST_CACHE_BREAKPOINT)) return block;
		changed = true;
		const clone = { ...block } as TBlock & { [REQUEST_CACHE_BREAKPOINT]?: unknown };
		delete clone[REQUEST_CACHE_BREAKPOINT];
		return clone;
	});
	return changed ? stripped : undefined;
}

/**
 * Remove request-only cache metadata before an open-ended provider receives
 * Context. Clone only the affected message/content path and never mutate the
 * caller's private projection.
 */
export function stripRequestCacheBreakpoints(context: Context): Context {
	let contextChanged = false;
	const messages = context.messages.map((message): Message => {
		if (message.role === "user") {
			if (!Array.isArray(message.content)) return message;
			const content = stripContentBreakpoints(message.content);
			if (!content) return message;
			contextChanged = true;
			return { ...message, content };
		}
		if (message.role === "assistant") {
			const content = stripContentBreakpoints(message.content);
			if (!content) return message;
			contextChanged = true;
			return { ...message, content };
		}
		const content = stripContentBreakpoints(message.content);
		if (!content) return message;
		contextChanged = true;
		return { ...message, content };
	});

	return contextChanged ? { ...context, messages } : context;
}
