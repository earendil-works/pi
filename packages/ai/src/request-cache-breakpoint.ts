import { type ImageContent, type KnownApi, type Message, REQUEST_CACHE_BREAKPOINT, type TextContent } from "./types.ts";

export type RequestCacheBreakpointContent = TextContent | ImageContent;

export type RequestCacheBreakpointBehavior = "capability-gated" | "lower" | "strip";

export interface RequestCacheBreakpointSelection {
	requested: boolean;
	messageIndex?: number;
	contentIndex?: number;
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
	if (typeof content !== "object" || content === null) return false;
	if ((content as { [REQUEST_CACHE_BREAKPOINT]?: unknown })[REQUEST_CACHE_BREAKPOINT] !== true) return false;
	const candidate = content as Record<PropertyKey, unknown>;
	return (
		(candidate.type === "text" && typeof candidate.text === "string") ||
		(candidate.type === "image" && typeof candidate.data === "string" && typeof candidate.mimeType === "string")
	);
}

export function hasCacheableRequestCacheBreakpoint(
	content: RequestCacheBreakpointContent,
): content is RequestCacheBreakpointContent {
	return hasRequestCacheBreakpoint(content) && isRequestCacheBreakpointContentCacheable(content);
}

/**
 * Select the last marked user block from the exact transformed graph consumed
 * by a serializer. Structural coordinates survive later block conversion and
 * avoid coupling cache policy to object identity. A malformed later marker
 * clears an earlier valid selection so adapters fail closed.
 */
export function selectRequestCacheBreakpoint(messages: readonly Message[]): RequestCacheBreakpointSelection {
	let requested = false;
	let messageIndex: number | undefined;
	let contentIndex: number | undefined;
	for (let nextMessageIndex = 0; nextMessageIndex < messages.length; nextMessageIndex++) {
		const message = messages[nextMessageIndex];
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		for (let nextContentIndex = 0; nextContentIndex < message.content.length; nextContentIndex++) {
			const block = message.content[nextContentIndex];
			if (!Object.hasOwn(block, REQUEST_CACHE_BREAKPOINT)) continue;
			requested = true;
			if (hasRequestCacheBreakpoint(block) && isRequestCacheBreakpointContentCacheable(block)) {
				messageIndex = nextMessageIndex;
				contentIndex = nextContentIndex;
			} else {
				messageIndex = undefined;
				contentIndex = undefined;
			}
		}
	}
	return messageIndex !== undefined && contentIndex !== undefined
		? { requested, messageIndex, contentIndex }
		: { requested };
}

export function isSelectedRequestCacheBreakpoint(
	selection: RequestCacheBreakpointSelection,
	messageIndex: number,
	contentIndex: number,
): boolean {
	return selection.messageIndex === messageIndex && selection.contentIndex === contentIndex;
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
