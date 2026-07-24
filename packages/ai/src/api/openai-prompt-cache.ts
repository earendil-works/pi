import type { CacheRetention } from "../types.ts";

export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export interface OpenAIExplicitPromptCacheOptions {
	mode: "explicit";
	ttl?: "30m";
}

export interface OpenAIPromptCachePlan {
	requestCacheBreakpoint: boolean;
	promptCacheRetention?: "24h";
}

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

/**
 * Resolve the request-wide OpenAI cache contract before payload dispatch.
 * Explicit content breakpoints and the 30-minute request option are one
 * capability: legacy 24-hour retention never crosses that boundary.
 */
export function planOpenAIPromptCache(
	explicitBreakpointCapability: boolean,
	cacheRetention: CacheRetention,
	supportsLongCacheRetention: boolean,
): OpenAIPromptCachePlan {
	if (explicitBreakpointCapability) {
		if (cacheRetention === "long") {
			throw new Error(
				"OpenAI explicit prompt cache long retention is unsupported; use short retention (30m) or disable caching",
			);
		}
		return {
			requestCacheBreakpoint: cacheRetention === "short",
		};
	}

	return {
		requestCacheBreakpoint: false,
		promptCacheRetention: cacheRetention === "long" && supportsLongCacheRetention ? "24h" : undefined,
	};
}

export function getOpenAIExplicitPromptCacheOptions(
	plan: OpenAIPromptCachePlan,
	requestCacheBreakpointSelected: boolean,
): OpenAIExplicitPromptCacheOptions | undefined {
	if (!plan.requestCacheBreakpoint || !requestCacheBreakpointSelected) return undefined;
	return { mode: "explicit", ttl: "30m" };
}
