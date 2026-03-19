import type { ServiceUsageLimits, ServiceUsageLimitWindow } from "../types.js";
import { getOAuthApiKey } from "./oauth/index.js";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const USAGE_BETA_HEADER = "oauth-2025-04-20";
const FIVE_HOUR_MINUTES = 5 * 60;
const WEEKLY_MINUTES = 7 * 24 * 60;
const SUCCESS_CACHE_MS = 60_000;
const ERROR_CACHE_MS = 30_000;

type AnthropicUsageWindow = {
	utilization?: number | null;
	resets_at?: string | null;
};

type AnthropicUsageResponse = {
	five_hour?: AnthropicUsageWindow;
	seven_day?: AnthropicUsageWindow;
};

let cachedValue: ServiceUsageLimits | null = null;
let cacheExpiresAt = 0;

function toEpochSeconds(timestamp: string | null | undefined): number | undefined {
	if (!timestamp) return undefined;
	const parsed = Date.parse(timestamp);
	if (Number.isNaN(parsed)) return undefined;
	return Math.floor(parsed / 1000);
}

function toWindow(
	usedPercent: number | null | undefined,
	windowMinutes: number,
	resetsAt: string | null | undefined,
): ServiceUsageLimitWindow | undefined {
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
	return {
		usedPercent,
		windowMinutes,
		resetsAt: toEpochSeconds(resetsAt),
	};
}

export function parseAnthropicOAuthUsageResponse(payload: AnthropicUsageResponse): ServiceUsageLimits | null {
	const primary = toWindow(payload.five_hour?.utilization, FIVE_HOUR_MINUTES, payload.five_hour?.resets_at);
	const secondary = toWindow(payload.seven_day?.utilization, WEEKLY_MINUTES, payload.seven_day?.resets_at);
	if (!primary && !secondary) return null;
	return { primary, secondary };
}

/** Reset module cache. Primarily for tests. */
export function resetAnthropicOAuthUsageCache(): void {
	cachedValue = null;
	cacheExpiresAt = 0;
}

export async function fetchAnthropicOAuthUsageLimits(options?: {
	force?: boolean;
}): Promise<ServiceUsageLimits | null> {
	const now = Date.now();
	if (!options?.force && now < cacheExpiresAt) {
		return cachedValue;
	}

	const token = await getOAuthApiKey("anthropic");
	if (!token) {
		cacheExpiresAt = now + ERROR_CACHE_MS;
		return cachedValue;
	}

	try {
		const response = await fetch(USAGE_ENDPOINT, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": USAGE_BETA_HEADER,
				"content-type": "application/json",
			},
		});

		if (!response.ok) {
			cacheExpiresAt = now + ERROR_CACHE_MS;
			return cachedValue;
		}

		const body = (await response.json()) as AnthropicUsageResponse;
		cachedValue = parseAnthropicOAuthUsageResponse(body);
		cacheExpiresAt = now + SUCCESS_CACHE_MS;
		return cachedValue;
	} catch {
		cacheExpiresAt = now + ERROR_CACHE_MS;
		return cachedValue;
	}
}
