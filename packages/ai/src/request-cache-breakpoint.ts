import { type ImageContent, type KnownApi, type Message, REQUEST_CACHE_BREAKPOINT, type TextContent } from "./types.ts";

export type RequestCacheBreakpointContent = TextContent | ImageContent;

export type RequestCacheBreakpointBehavior = "capability-gated" | "lower" | "strip";

export interface RequestCacheBreakpointSelection {
	requested: boolean;
	content?: RequestCacheBreakpointContent;
}

/**
 * Exhaustive provider contract for the private request marker.
 *
 * A new KnownApi must declare a behavior here before TypeScript will compile.
 * Open-ended/custom APIs use the fail-closed default below.
 */
export const REQUEST_CACHE_BREAKPOINT_BEHAVIOR_BY_API = {
	"openai-completions": "capability-gated",
	"mistral-conversations": "strip",
	"openai-responses": "capability-gated",
	"azure-openai-responses": "strip",
	"openai-codex-responses": "strip",
	"anthropic-messages": "lower",
	"bedrock-converse-stream": "strip",
	"google-generative-ai": "strip",
	"google-vertex": "strip",
	"pi-messages": "strip",
} as const satisfies Record<KnownApi, RequestCacheBreakpointBehavior>;

export const CUSTOM_API_REQUEST_CACHE_BREAKPOINT_BEHAVIOR: RequestCacheBreakpointBehavior = "strip";

export function isRequestCacheBreakpointContentCacheable(content: RequestCacheBreakpointContent): boolean {
	if (content.type === "text") {
		return content.text.trim().length > 0;
	}
	return content.data.trim().length > 0 && content.mimeType.trim().length > 0;
}

export function hasRequestCacheBreakpoint(content: unknown): content is RequestCacheBreakpointContent {
	return (
		typeof content === "object" &&
		content !== null &&
		(content as { [REQUEST_CACHE_BREAKPOINT]?: unknown })[REQUEST_CACHE_BREAKPOINT] === true
	);
}

export function hasCacheableRequestCacheBreakpoint(
	content: RequestCacheBreakpointContent,
): content is RequestCacheBreakpointContent {
	return hasRequestCacheBreakpoint(content) && isRequestCacheBreakpointContentCacheable(content);
}

/**
 * Select the last valid marked user block while retaining whether any marker
 * was requested. Adapters can then fail closed instead of silently moving an
 * invalid marker to a different block.
 */
export function selectRequestCacheBreakpoint(messages: readonly Message[]): RequestCacheBreakpointSelection {
	let requested = false;
	let content: RequestCacheBreakpointContent | undefined;
	for (const message of messages) {
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!hasRequestCacheBreakpoint(block)) continue;
			requested = true;
			if (isRequestCacheBreakpointContentCacheable(block)) {
				content = block;
			}
		}
	}
	return content ? { requested, content } : { requested };
}

/**
 * Clone a stable content block and mark the clone for request-only projection.
 */
export function markRequestCacheBreakpoint<TContent extends RequestCacheBreakpointContent>(
	content: TContent,
): TContent {
	if (!isRequestCacheBreakpointContentCacheable(content)) {
		throw new TypeError("Request cache breakpoints require a cacheable non-empty content block");
	}
	return {
		...content,
		[REQUEST_CACHE_BREAKPOINT]: true,
	};
}
