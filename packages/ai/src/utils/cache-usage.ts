import type { KnownApi } from "../types.ts";

export interface NormalizedCacheTokenUsage {
	tokens: number;
	reported: boolean;
}

export type CacheUsageAvailabilitySource = "raw-field-presence" | "protocol-field-presence" | "unavailable";

export interface CacheUsageAvailability {
	read: CacheUsageAvailabilitySource;
	write: CacheUsageAvailabilitySource;
}

/**
 * Exhaustive availability contract for every stable message API. Custom APIs
 * remain unavailable until an adapter adds an explicit, tested contract.
 */
export const CACHE_USAGE_AVAILABILITY_BY_API = {
	"openai-completions": { read: "raw-field-presence", write: "raw-field-presence" },
	"mistral-conversations": { read: "raw-field-presence", write: "unavailable" },
	"openai-responses": { read: "raw-field-presence", write: "raw-field-presence" },
	"azure-openai-responses": { read: "raw-field-presence", write: "raw-field-presence" },
	"openai-codex-responses": { read: "raw-field-presence", write: "raw-field-presence" },
	"anthropic-messages": { read: "raw-field-presence", write: "raw-field-presence" },
	"bedrock-converse-stream": { read: "raw-field-presence", write: "raw-field-presence" },
	"google-generative-ai": { read: "raw-field-presence", write: "unavailable" },
	"google-vertex": { read: "raw-field-presence", write: "unavailable" },
	"pi-messages": { read: "protocol-field-presence", write: "protocol-field-presence" },
} as const satisfies Record<KnownApi, CacheUsageAvailability>;

export const CUSTOM_API_CACHE_USAGE_AVAILABILITY: CacheUsageAvailability = {
	read: "unavailable",
	write: "unavailable",
};

/**
 * Normalize an untrusted provider cache-token field without conflating an
 * explicit zero with absence. Invalid values never reach AssistantMessage.
 */
export function normalizeCacheTokenUsage(raw: unknown): NormalizedCacheTokenUsage {
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
		return { tokens: 0, reported: false };
	}
	return { tokens: raw, reported: true };
}
