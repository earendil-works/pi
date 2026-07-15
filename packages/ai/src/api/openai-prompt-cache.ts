export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

/**
 * Clamp a session id destined for a request *header* to the same 64-char limit
 * the ChatGPT Codex backend enforces on `prompt_cache_key` (it validates the
 * `session-id` / `x-client-request-id` header values against the same rules).
 *
 * The body's `prompt_cache_key` is already clamped via
 * {@link clampOpenAIPromptCacheKey}, but the headers were sent raw — so a long
 * `options.sessionId` (e.g. a ~150-char Claude Code `metadata.user_id` mapped
 * to sessionId by a proxy) made every request fail with HTTP 400
 * `[prompt_cache_key] [string_above_max_length]` (#6630).
 *
 * Clamps the same way the body field does so the header and body stay
 * consistent for a given session. (A long-prefix-collision-resistant hash would
 * avoid collapsing distinct long-prefix sessions into one key; that's a
 * follow-up that would have to change the body field too.)
 */
export function clampSessionIdHeader(sessionId: string | undefined): string | undefined {
	return clampOpenAIPromptCacheKey(sessionId);
}
