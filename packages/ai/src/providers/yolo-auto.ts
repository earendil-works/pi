import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model, ThinkingLevelMap } from "../types.ts";
import { YOLO_AUTO_MODELS } from "./yolo-auto.models.ts";

export const YOLO_AUTO_BASE_URL = "https://yolo-auto.com/v1";

/** Output cap advertised for the proxy routes. The proxy clamps each request to the remaining plan window. */
export const YOLO_AUTO_MAX_OUTPUT_TOKENS = 32768;

/**
 * Maps pi thinking levels to the `reasoning_effort` values the Yolo-Auto proxy accepts.
 * The proxy advertises minimal through xhigh; pi clamps `max` down to the highest
 * supported level, so it stays unsupported here like in the generated baseline.
 */
export const YOLO_AUTO_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: null,
};

/** Fallback window when a listing entry omits context metadata. Matches the proxy's own default. */
const DEFAULT_CONTEXT_WINDOW = 131072;

type YoloAutoListingEntry = {
	id?: unknown;
	context_length?: unknown;
	thinking?: unknown;
};

function positiveInteger(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 1) return Math.floor(value);
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
	}
	return undefined;
}

function thinkingLevels(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const levels = value.filter((level): level is string => typeof level === "string" && level.length > 0);
	return levels.length > 0 ? levels : undefined;
}

/**
 * Turns a `/v1/models` payload into models for this provider. Entries are plan-bounded: the
 * listing reports only the models the caller's plan can use and the context window it enforces.
 * Listing metadata is sparse (id, window, thinking levels), so each entry inherits cost,
 * modalities, and compat from the static baseline when IDs match.
 */
export function parseYoloAutoListing(
	providerId: string,
	baseUrl: string,
	body: unknown,
): Model<"openai-completions">[] {
	if (!body || typeof body !== "object" || !("data" in body)) return [];
	const data = body.data;
	if (!Array.isArray(data)) return [];

	const baselineById = new Map<string, Model<"openai-completions">>();
	for (const model of Object.values(YOLO_AUTO_MODELS)) {
		baselineById.set(model.id, model);
	}

	const models: Model<"openai-completions">[] = [];
	const seen = new Set<string>();
	for (const raw of data as YoloAutoListingEntry[]) {
		if (typeof raw !== "object" || raw === null) continue;
		const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : undefined;
		if (!id || seen.has(id)) continue;
		seen.add(id);

		const baseline = baselineById.get(id);
		const levels = thinkingLevels(raw.thinking);
		const advertisedLevels = levels?.filter((level) => level in YOLO_AUTO_THINKING_LEVEL_MAP && level !== "off");
		const reasoning = advertisedLevels !== undefined ? advertisedLevels.length > 0 : (baseline?.reasoning ?? false);

		models.push({
			id,
			name: baseline?.name ?? id,
			api: "openai-completions",
			provider: providerId,
			baseUrl,
			reasoning,
			thinkingLevelMap: reasoning ? YOLO_AUTO_THINKING_LEVEL_MAP : undefined,
			input: baseline?.input ?? ["text"],
			inputLimits: baseline?.inputLimits,
			cost: baseline?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: positiveInteger(raw.context_length) ?? baseline?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: Math.min(
				baseline?.maxTokens ?? YOLO_AUTO_MAX_OUTPUT_TOKENS,
				positiveInteger(raw.context_length) ?? Number.POSITIVE_INFINITY,
			),
			compat: baseline?.compat,
		});
	}
	return models;
}

async function fetchYoloAutoModels(context: RefreshModelsContext): Promise<readonly Model<"openai-completions">[]> {
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	const response = await fetch(`${YOLO_AUTO_BASE_URL}/models`, {
		headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Yolo-Auto model listing failed with HTTP ${response.status}`);
	}
	return parseYoloAutoListing("yolo-auto", YOLO_AUTO_BASE_URL, await response.json());
}

/**
 * Yolo-Auto: subscription-backed OpenAI-compatible gateway. The static baseline ships the
 * current public routes; `refreshModels` overlays the plan-bounded listing from `/v1/models`,
 * which reports the exact models the caller's plan can use and the context window it enforces.
 */
export function yoloAutoProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "yolo-auto",
		name: "Yolo-Auto",
		baseUrl: YOLO_AUTO_BASE_URL,
		auth: { apiKey: envApiKeyAuth("Yolo-Auto API key", ["YOLO_AUTO_API_KEY"]) },
		models: Object.values(YOLO_AUTO_MODELS),
		fetchModels: fetchYoloAutoModels,
		api: openAICompletionsApi(),
	});
}
