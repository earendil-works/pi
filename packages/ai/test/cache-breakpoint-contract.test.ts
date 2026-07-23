import { describe, expect, it } from "vitest";
import {
	CUSTOM_API_REQUEST_CACHE_BREAKPOINT_BEHAVIOR,
	hasRequestCacheBreakpoint,
	type KnownApi,
	markRequestCacheBreakpoint,
	REQUEST_CACHE_BREAKPOINT,
	REQUEST_CACHE_BREAKPOINT_BEHAVIOR_BY_API,
	type TextContent,
} from "../src/index.ts";

const KNOWN_APIS = [
	"openai-completions",
	"mistral-conversations",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
	"pi-messages",
] as const satisfies readonly KnownApi[];

describe("request cache breakpoint contract", () => {
	it("keeps the KnownApi lowering policy exhaustive and fail-closed", () => {
		expect(Object.keys(REQUEST_CACHE_BREAKPOINT_BEHAVIOR_BY_API)).toEqual(KNOWN_APIS);
		expect(REQUEST_CACHE_BREAKPOINT_BEHAVIOR_BY_API).toEqual({
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
		});
		expect(CUSTOM_API_REQUEST_CACHE_BREAKPOINT_BEHAVIOR).toBe("strip");
	});

	it("uses a symbol marker that cannot be forged through model-visible JSON", () => {
		const original: TextContent = { type: "text", text: "stable prefix" };
		const marked = markRequestCacheBreakpoint(original);

		expect(marked).not.toBe(original);
		expect(marked[REQUEST_CACHE_BREAKPOINT]).toBe(true);
		expect(hasRequestCacheBreakpoint(marked)).toBe(true);
		expect(JSON.stringify(marked)).toBe('{"type":"text","text":"stable prefix"}');

		const roundTripped = JSON.parse(JSON.stringify(marked)) as TextContent;
		expect(hasRequestCacheBreakpoint(roundTripped)).toBe(false);
		expect(
			hasRequestCacheBreakpoint({
				type: "text",
				text: "stable prefix",
				requestCacheBreakpoint: true,
			}),
		).toBe(false);
	});

	it("accepts cacheable text and image blocks and rejects empty blocks before wire conversion", () => {
		expect(
			hasRequestCacheBreakpoint(
				markRequestCacheBreakpoint({
					type: "image",
					data: "aW1hZ2U=",
					mimeType: "image/png",
				}),
			),
		).toBe(true);

		expect(() => markRequestCacheBreakpoint({ type: "text", text: "" })).toThrow(/cacheable/i);
		expect(() =>
			markRequestCacheBreakpoint({
				type: "image",
				data: "",
				mimeType: "image/png",
			}),
		).toThrow(/cacheable/i);
	});
});
