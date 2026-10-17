// Adapted from pi-antigravity (MIT), Copyright (c) 2026 Rahul Arya.
// See LICENSE in this directory.
import type { Model } from "../../types.ts";

type ProviderModelConfig = Omit<Model<"antigravity-api">, "api" | "provider" | "baseUrl">;

import { ThinkingEffort } from "./enums.ts";
import type { AntigravityRouting, ThinkingWire } from "./types.ts";

export const PROVIDER_ID = "antigravity";
export const PROVIDER_NAME = "Antigravity";

/**
 * Public selectable model IDs → backend request model IDs by thinking effort.
 *
 * Catalog mirrors `agy models` (Antigravity CLI), which currently advertises:
 * - Gemini 3.8 Flash (Low / Medium / High)
 * - Gemini 3.7 Flash (Low / Medium / High)
 * - Gemini 3.6 Flash (Low / Medium / High)
 * - Gemini 3.5 Flash (Low / Medium / High)
 * - Gemini 3.1 Pro (Low / High)
 * - Claude Sonnet 4.6 (Thinking)
 * - Claude Opus 4.6 (Thinking)
 * - GPT-OSS 120B (Medium)
 *
 * Pi exposes those as public model IDs and only surfaces the exact thinking levels
 * advertised by the backend for each model.
 */
export const ANTIGRAVITY_ROUTING: Record<string, AntigravityRouting> = {
	"gemini-4-argon": {
		off: "gemini-4-argon-low",
		routing: {
			minimal: "gemini-4-argon-low",
			low: "gemini-4-argon-low",
			medium: "gemini-4-argon-medium",
			high: "gemini-4-argon-high",
			xhigh: "gemini-4-argon-high",
		},
		defaultRequestId: "gemini-4-argon-low",
	},
	"claude-opus-5-5": {
		off: "claude-opus-5-5-low",
		routing: {
			minimal: "claude-opus-5-5-low",
			low: "claude-opus-5-5-low",
			medium: "claude-opus-5-5-medium",
			high: "claude-opus-5-5-high",
			xhigh: "claude-opus-5-5-high",
		},
		defaultRequestId: "claude-opus-5-5-low",
	},
	"claude-sonnet-5-5": {
		off: "claude-sonnet-5-5-low",
		routing: {
			minimal: "claude-sonnet-5-5-low",
			low: "claude-sonnet-5-5-low",
			medium: "claude-sonnet-5-5-medium",
			high: "claude-sonnet-5-5-high",
			xhigh: "claude-sonnet-5-5-high",
		},
		defaultRequestId: "claude-sonnet-5-5-low",
	},
	"claude-opus-4-6": {
		routing: {
			minimal: "claude-opus-4-6-thinking",
			low: "claude-opus-4-6-thinking",
			medium: "claude-opus-4-6-thinking",
			high: "claude-opus-4-6-thinking",
		},
		defaultRequestId: "claude-opus-4-6-thinking",
	},
	// Live fetchAvailableModels exposes `claude-sonnet-4-6` (display: Thinking), not a separate *-thinking id.
	"claude-sonnet-4-6": {
		off: "claude-sonnet-4-6",
		routing: {
			minimal: "claude-sonnet-4-6",
			low: "claude-sonnet-4-6",
			medium: "claude-sonnet-4-6",
			high: "claude-sonnet-4-6",
			xhigh: "claude-sonnet-4-6",
		},
		defaultRequestId: "claude-sonnet-4-6",
	},
	"gemini-3.1-pro": {
		// `gemini-3.1-pro-high` is advertised but currently 400s for agent streamGenerateContent;
		// `gemini-pro-agent` is the working High runtime id (same display name in fetchAvailableModels).
		off: "gemini-3.1-pro-low",
		routing: {
			minimal: "gemini-3.1-pro-low",
			low: "gemini-3.1-pro-low",
			medium: "gemini-3.1-pro-low",
			high: "gemini-pro-agent",
			xhigh: "gemini-pro-agent",
		},
		defaultRequestId: "gemini-3.1-pro-low",
	},
	"gemini-3.8-flash": {
		off: "gemini-3.8-flash-low",
		routing: {
			minimal: "gemini-3.8-flash-low",
			low: "gemini-3.8-flash-low",
			medium: "gemini-3.8-flash-medium",
			high: "gemini-3.8-flash-high",
			xhigh: "gemini-3.8-flash-high",
		},
		defaultRequestId: "gemini-3.8-flash-low",
	},
	"gemini-3.7-flash": {
		off: "gemini-3.7-flash-low",
		routing: {
			minimal: "gemini-3.7-flash-low",
			low: "gemini-3.7-flash-low",
			medium: "gemini-3.7-flash-medium",
			high: "gemini-3.7-flash-high",
			xhigh: "gemini-3.7-flash-high",
		},
		defaultRequestId: "gemini-3.7-flash-low",
	},
	"gemini-3.6-flash": {
		// agy models: gemini-3.6-flash-low / -medium / -high
		off: "gemini-3.6-flash-low",
		routing: {
			minimal: "gemini-3.6-flash-low",
			low: "gemini-3.6-flash-low",
			medium: "gemini-3.6-flash-medium",
			high: "gemini-3.6-flash-high",
			xhigh: "gemini-3.6-flash-high",
		},
		defaultRequestId: "gemini-3.6-flash-low",
	},
	"gemini-3.5-flash": {
		off: "gemini-3.5-flash-extra-low",
		routing: {
			minimal: "gemini-3.5-flash-extra-low",
			low: "gemini-3.5-flash-extra-low",
			medium: "gemini-3.5-flash-low",
			high: "gemini-3-flash-agent",
			xhigh: "gemini-3-flash-agent",
		},
		defaultRequestId: "gemini-3.5-flash-extra-low",
	},
	"gpt-oss-120b": {
		off: "gpt-oss-120b-medium",
		routing: {
			minimal: "gpt-oss-120b-medium",
			low: "gpt-oss-120b-medium",
			medium: "gpt-oss-120b-medium",
			high: "gpt-oss-120b-medium",
		},
		defaultRequestId: "gpt-oss-120b-medium",
	},
};

/**
 * Verified maximum output tokens accepted by the Cloud Code Assist backend per model/runtime ID.
 * Requesting more than these limits returns a 400 Bad Request from the API.
 */
export const RUNTIME_MAX_OUTPUT_TOKENS: Record<string, number> = {
	"gemini-4-argon": 65536,
	"gemini-4-argon-low": 65536,
	"gemini-4-argon-medium": 65536,
	"gemini-4-argon-high": 65536,
	"claude-opus-5-5": 128000,
	"claude-opus-5-5-low": 128000,
	"claude-opus-5-5-medium": 128000,
	"claude-opus-5-5-high": 128000,
	"claude-sonnet-5-5": 128000,
	"claude-sonnet-5-5-low": 128000,
	"claude-sonnet-5-5-medium": 128000,
	"claude-sonnet-5-5-high": 128000,
	"gemini-3.8-flash": 65536,
	"gemini-3.8-flash-low": 65536,
	"gemini-3.8-flash-medium": 65536,
	"gemini-3.8-flash-high": 65536,
	"gemini-3.7-flash": 65536,
	"gemini-3.7-flash-tiered": 65536,
	// Retain rollout-era IDs for compatibility with pinned runtime overrides.
	"gemini-3.7-flash-low": 65536,
	"gemini-3.7-flash-medium": 65536,
	"gemini-3.7-flash-high": 65536,
	"gemini-3.6-flash": 65536,
	"gemini-3.6-flash-low": 65536,
	"gemini-3.6-flash-medium": 65536,
	"gemini-3.6-flash-high": 65536,
	"gemini-3.5-flash": 65536,
	"gemini-3.5-flash-extra-low": 65536,
	"gemini-3.5-flash-low": 65536,
	"gemini-3-flash-agent": 65536,
	"gemini-3.1-pro": 65535,
	"gemini-3.1-pro-low": 65535,
	"gemini-3.1-pro-high": 65535,
	"gemini-pro-agent": 65535,
	"claude-opus-4-6": 64000,
	"claude-opus-4-6-thinking": 64000,
	"claude-sonnet-4-6": 64000,
	"gpt-oss-120b": 32768,
	"gpt-oss-120b-medium": 32768,
};

export function getMaxOutputTokens(modelId: string, runtimeModel?: string): number {
	if (runtimeModel && RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel] !== undefined) {
		return RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel];
	}
	if (RUNTIME_MAX_OUTPUT_TOKENS[modelId] !== undefined) {
		return RUNTIME_MAX_OUTPUT_TOKENS[modelId];
	}
	if (runtimeModel) {
		if (runtimeModel.startsWith("claude-opus-5") || runtimeModel.startsWith("claude-sonnet-5")) return 128000;
		if (runtimeModel.startsWith("claude-")) return 64000;
		if (runtimeModel.startsWith("gpt-oss-")) return 32768;
		if (runtimeModel.startsWith("gemini-3.1-pro") || runtimeModel === "gemini-pro-agent") return 65535;
		if (runtimeModel.startsWith("gemini-")) return 65536;
	}
	return 8192;
}

const geminiFlashCost = { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 };
const geminiProCost = { input: 1.25, output: 5.0, cacheRead: 0.3125, cacheWrite: 1.25 };
const claudeSonnetCost = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };
const claudeOpusCost = { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 };
const gptOssCost = { input: 0.6, output: 2.4, cacheRead: 0.15, cacheWrite: 0.6 };

// A null entry is intentionally hidden by Pi. Do not collapse levels that happen to
// route to the same runtime ID: the UI must reflect the levels the backend advertises.
const thinkingLevelMaps = {
	lowMediumHigh: {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	},
	lowHigh: {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	},
	thinking: {
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	},
	medium: {
		off: null,
		minimal: null,
		low: null,
		medium: "medium",
		high: null,
		xhigh: null,
		max: null,
	},
} satisfies Record<string, ProviderModelConfig["thinkingLevelMap"]>;

/** Same set as `agy models`, collapsed to public Pi model IDs. */
export const ANTIGRAVITY_MODELS: ProviderModelConfig[] = [
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash (Antigravity)",
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
		input: ["text", "image"],
		cost: geminiFlashCost,
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3.7-flash",
		name: "Gemini 3.7 Flash (Antigravity)",
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
		input: ["text", "image"],
		cost: geminiFlashCost,
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash (Antigravity)",
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
		input: ["text", "image"],
		cost: geminiFlashCost,
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5 (Antigravity)",
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
		input: ["text", "image"],
		cost: claudeOpusCost,
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5 (Antigravity)",
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
		input: ["text", "image"],
		cost: claudeSonnetCost,
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "gemini-4-argon",
		name: "Gemini 4 Argon (Antigravity)",
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
		input: ["text", "image"],
		cost: geminiProCost,
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro (Antigravity)",
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowHigh,
		input: ["text", "image"],
		cost: geminiProCost,
		contextWindow: 1048576,
		maxTokens: 65535,
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash (Antigravity)",
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.lowMediumHigh,
		input: ["text", "image"],
		cost: geminiFlashCost,
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	{
		id: "gpt-oss-120b",
		name: "GPT-OSS 120B (Antigravity)",
		reasoning: true,
		thinkingLevelMap: thinkingLevelMaps.medium,
		input: ["text"],
		cost: gptOssCost,
		contextWindow: 131072,
		maxTokens: 32768,
	},
];

/** Resolve public model id + thinking effort to Antigravity runtime model id. */
export function getAntigravityRequestModelId(modelId: string, effort: string | undefined): string {
	const r = ANTIGRAVITY_ROUTING[modelId];
	if (!r) return modelId;

	if (effort === undefined || effort === "off") {
		return r.off ?? r.routing?.minimal ?? r.routing?.low ?? r.defaultRequestId ?? modelId;
	}

	const effortKey = effort as ThinkingEffort;
	if (effortKey === ThinkingEffort.Xhigh) {
		return (
			r.routing?.xhigh ??
			r.routing?.high ??
			r.routing?.low ??
			r.routing?.minimal ??
			r.off ??
			r.defaultRequestId ??
			modelId
		);
	}

	return r.routing?.[effortKey] ?? r.routing?.low ?? r.routing?.minimal ?? r.off ?? r.defaultRequestId ?? modelId;
}

/**
 * If a next-gen model (e.g. Gemini 3.8 Flash) is not yet available on the backend,
 * provide a fallback runtime model ID (e.g. Gemini 3.7 Flash) to maintain availability.
 */
export function getFallbackRuntimeModel(runtimeModel: string, effort?: string): string | undefined {
	if (runtimeModel.startsWith("gemini-3.8-flash-")) {
		return runtimeModel.replace("gemini-3.8-flash-", "gemini-3.7-flash-");
	}
	if (runtimeModel === "gemini-3.8-flash") {
		return "gemini-3.7-flash-low";
	}
	if (runtimeModel === "gemini-3.7-flash-tiered") {
		return getAntigravityRequestModelId("gemini-3.6-flash", effort);
	}
	if (runtimeModel.startsWith("gemini-3.7-flash-")) {
		return runtimeModel.replace("gemini-3.7-flash-", "gemini-3.6-flash-");
	}
	if (runtimeModel === "gemini-3.7-flash") {
		return "gemini-3.6-flash-low";
	}
	return undefined;
}

export type { ThinkingWire };

export const ANTIGRAVITY_MODEL_ENUM: Record<string, string> = {
	// Gemini 4 Argon
	"gemini-4-argon": "MODEL_PLACEHOLDER_M418",
	"gemini-4-argon-high": "MODEL_PLACEHOLDER_M417",
	"gemini-4-argon-medium": "MODEL_PLACEHOLDER_M418",
	"gemini-4-argon-low": "MODEL_PLACEHOLDER_M419",
	// Gemini 3.8 Flash
	"gemini-3.8-flash": "MODEL_PLACEHOLDER_M318",
	"gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M318",
	"gemini-3.8-flash-medium": "MODEL_PLACEHOLDER_M319",
	"gemini-3.8-flash-low": "MODEL_PLACEHOLDER_M320",
	"gemini-3.8-flash-tiered": "MODEL_PLACEHOLDER_M322",
	// Gemini 3.7 Flash
	"gemini-3.7-flash": "MODEL_PLACEHOLDER_M298",
	"gemini-3.7-flash-high": "MODEL_PLACEHOLDER_M298",
	"gemini-3.7-flash-medium": "MODEL_PLACEHOLDER_M299",
	"gemini-3.7-flash-low": "MODEL_PLACEHOLDER_M300",
	"gemini-3.7-flash-tiered": "MODEL_PLACEHOLDER_M301",
	// Gemini 3.6 Flash
	"gemini-3.6-flash": "MODEL_PLACEHOLDER_M71",
	"gemini-3.6-flash-high": "MODEL_PLACEHOLDER_M71",
	"gemini-3.6-flash-medium": "MODEL_PLACEHOLDER_M72",
	"gemini-3.6-flash-low": "MODEL_PLACEHOLDER_M73",
	"gemini-3.6-flash-tiered": "MODEL_PLACEHOLDER_M196",
	// Gemini 3.5 Flash
	"gemini-3.5-flash": "MODEL_PLACEHOLDER_M20",
	"gemini-3.5-flash-extra-low": "MODEL_PLACEHOLDER_M187",
	"gemini-3.5-flash-low": "MODEL_PLACEHOLDER_M20",
	"gemini-3-flash-agent": "MODEL_PLACEHOLDER_M84",
	// Gemini 3.1 Pro
	"gemini-3.1-pro": "MODEL_PLACEHOLDER_M36",
	"gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36",
	"gemini-3.1-pro-high": "MODEL_PLACEHOLDER_M37",
	"gemini-pro-agent": "MODEL_PLACEHOLDER_M16",
	// Claude 5.5
	"claude-opus-5-5": "MODEL_PLACEHOLDER_M400",
	"claude-opus-5-5-low": "MODEL_PLACEHOLDER_M400",
	"claude-opus-5-5-medium": "MODEL_PLACEHOLDER_M401",
	"claude-opus-5-5-high": "MODEL_PLACEHOLDER_M402",
	"claude-sonnet-5-5": "MODEL_PLACEHOLDER_M403",
	"claude-sonnet-5-5-low": "MODEL_PLACEHOLDER_M403",
	"claude-sonnet-5-5-medium": "MODEL_PLACEHOLDER_M404",
	"claude-sonnet-5-5-high": "MODEL_PLACEHOLDER_M405",
	// Claude 4.6
	"claude-sonnet-4-6": "MODEL_PLACEHOLDER_M35",
	"claude-opus-4-6": "MODEL_PLACEHOLDER_M26",
	"claude-opus-4-6-thinking": "MODEL_PLACEHOLDER_M26",
	// GPT-OSS
	"gpt-oss-120b": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
	"gpt-oss-120b-medium": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
};

export function getModelEnum(id: string): string | undefined {
	return ANTIGRAVITY_MODEL_ENUM[id] ?? ANTIGRAVITY_MODEL_ENUM[getAntigravityRequestModelId(id, undefined)];
}

export function getThinkingConfig(modelId: string, effort: string | undefined): ThinkingWire | undefined {
	if (modelId.startsWith("claude-")) {
		if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
		return { includeThoughts: true, thinkingBudget: 1024 };
	}
	if (modelId.startsWith("gpt-oss-")) {
		if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
		return { includeThoughts: true, thinkingBudget: 8192 };
	}
	if (modelId.startsWith("gemini-4-argon")) {
		// Argon rejects thinkingBudget 0 with a 400. Omitting thinkingConfig is the
		// working no-thinking mode (verified on -low and -high); every other level
		// keeps the dynamic budget and lets the wire variant carry the effort.
		if (!effort || effort === "off") return undefined;
		return { includeThoughts: true, thinkingBudget: -1 };
	}
	// Gemini 3 Flash advertises minThinkingBudget 32 and answers thinkingBudget 0 with a 400.
	// Omitting thinkingConfig is its working no-thinking mode (verified live 2026-10-17);
	// other levels use the generic Gemini budgets below.
	if (modelId === "gemini-3-flash" && (!effort || effort === "off")) return undefined;
	if (modelId.startsWith("gemini-3.5-flash") || modelId === "gemini-3-flash-agent") {
		if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
		const thinkingBudget = effort === "high" || effort === "xhigh" ? 10_000 : effort === "medium" ? 4_000 : 1_000;
		return { includeThoughts: true, thinkingBudget };
	}
	if (modelId.startsWith("gemini-3.1-pro") || modelId === "gemini-pro-agent") {
		if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
		return {
			includeThoughts: true,
			thinkingBudget: effort === "high" || effort === "xhigh" ? 10_001 : 1_001,
		};
	}
	if (modelId.startsWith("gemini-")) {
		if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
		const thinkingBudget = effort === "high" || effort === "xhigh" ? -1 : effort === "medium" ? 4_000 : 1_000;
		return { includeThoughts: true, thinkingBudget };
	}
	return undefined;
}
