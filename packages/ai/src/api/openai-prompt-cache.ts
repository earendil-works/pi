export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
export const OPENAI_GPT_56_PROMPT_CACHE_OPTIONS = { mode: "implicit", ttl: "30m" } as const;

export interface OpenAIPromptCacheOptions {
	mode?: "implicit" | "explicit";
	ttl?: "30m";
}

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

export function isOpenAIGPT56Family(modelId: string): boolean {
	return /(?:^|[/.])gpt-5\.6(?:$|[-_/.])/.test(modelId.toLowerCase());
}

export function getOpenAIGPT56PromptCacheOptions(
	modelId: string,
	enabled: boolean,
): OpenAIPromptCacheOptions | undefined {
	return enabled && isOpenAIGPT56Family(modelId) ? OPENAI_GPT_56_PROMPT_CACHE_OPTIONS : undefined;
}
