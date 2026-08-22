import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model, OpenAICompletionsCompat } from "../types.ts";

/**
 * MindsHub (https://mindshub.ai) is an inference gateway: one API key and one
 * OpenAI-compatible Chat Completions endpoint (`https://api.mindshub.ai/v1`)
 * reach every model in its catalog (Claude, GPT, Gemini, Kimi, DeepSeek, Qwen,
 * GLM, Grok, and its own `mindshub_air`), all speaking the same wire format
 * regardless of which upstream provider actually serves the request. See
 * https://docs.mindshub.ai/inference/.
 *
 * The model catalog below is hand-maintained here in `mindshub.ts` rather
 * than in a sibling `mindshub.models.ts`, and deliberately so: every
 * `*.models.ts` file directly under `src/providers/` is owned by
 * `scripts/generate-models.ts`, which deletes any such file that isn't one
 * of its own generated shards (see the cleanup loop in that script). MindsHub
 * isn't indexed by models.dev, so it has no generated shard to keep in sync;
 * keeping the catalog inline avoids the naming collision instead of fighting
 * the generator on every run.
 *
 * Aliases and pricing come from https://docs.mindshub.ai/inference/models
 * and https://docs.mindshub.ai/inference/billing (current as of August
 * 2026; both pages note they change without notice — re-check them and
 * `GET /v1/models` before updating this file). Context windows are not
 * published by MindsHub itself; they reflect each underlying model's own
 * public specification (e.g. OpenAI's documented 272,000-token default
 * window for the GPT-5.6 family, matched here to MindsHub's own documented
 * long-context pricing threshold for `gpt`/`gpt-terra`/`gpt-luna`).
 *
 * `maxTokens` is set to 131,072 for every model: MindsHub enforces that as a
 * hard, documented cap on `max_tokens`/`max_completion_tokens` across the
 * entire catalog, rejecting anything higher with `400 max_tokens_exceeded`
 * regardless of the underlying model's own output limit.
 */

const MINDSHUB_BASE_URL = "https://api.mindshub.ai/v1";

/**
 * MindsHub normalizes every model behind one Chat Completions surface:
 * `system`/`user`/`assistant`/`tool` roles only (no `developer` role), no
 * OpenAI `store` semantics, and no long-retention prompt-cache controls or
 * `strict` tool-schema guarantees across a catalog this heterogeneous.
 */
const MINDSHUB_COMPAT: OpenAICompletionsCompat = {
	supportsDeveloperRole: false,
	supportsStore: false,
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
	supportsReasoningEffort: true,
	maxTokensField: "max_completion_tokens",
	thinkingFormat: "openai",
};

/** Claude family: `reasoning_effort` in `low` | `medium` | `high` | `max` (documented ladder for `sonnet`; applied uniformly across the family). */
const CLAUDE_THINKING_LEVEL_MAP = { minimal: null, low: "low", medium: "medium", high: "high", max: "max" } as const;

/** DeepSeek: "takes low, high and max" per MindsHub's chat-completions docs — no medium. */
const DEEPSEEK_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	max: "max",
} as const;

/** GPT-5.6 family: reasoning cannot be turned off (mirrors pi's own `openai` provider default for `gpt-5*`). */
const GPT_THINKING_LEVEL_MAP = { off: null } as const;

/** `gpt-mini`/`gpt-nano`: docs call out "adds none" alongside the low/medium/high ladder — `off` maps to `none`. */
const GPT_MINI_THINKING_LEVEL_MAP = { off: "none" } as const;

/** Gemini 3.x: modeled as a coarse low/high toggle; MindsHub doesn't document a finer ladder for it. */
const GEMINI_THINKING_LEVEL_MAP = { off: null, minimal: null, medium: null } as const;

/** Qwen/GLM: reason by default (grouped with the 16,384-default-max-tokens models); ladder narrowed to low/high. */
const QWEN_GLM_THINKING_LEVEL_MAP = { off: null, minimal: null, medium: null, max: null } as const;

function mindshubModel(
	id: string,
	name: string,
	cost: Model<"openai-completions">["cost"],
	contextWindow: number,
	options: {
		reasoning?: boolean;
		thinkingLevelMap?: Model<"openai-completions">["thinkingLevelMap"];
	} = {},
): Model<"openai-completions"> & { id: string; provider: "mindshub" } {
	return {
		id,
		name,
		api: "openai-completions",
		provider: "mindshub",
		baseUrl: MINDSHUB_BASE_URL,
		reasoning: options.reasoning ?? false,
		...(options.thinkingLevelMap ? { thinkingLevelMap: { ...options.thinkingLevelMap } } : {}),
		input: ["text", "image"],
		cost,
		contextWindow,
		maxTokens: 131072,
		compat: MINDSHUB_COMPAT,
	};
}

export const MINDSHUB_MODELS = {
	// Reasons internally on every request but the level isn't adjustable through MindsHub
	// (`reasoning_efforts: null`); documented explicitly as one of the two named examples.
	mindshub_air: mindshubModel(
		"mindshub_air",
		"MindsHub Air",
		{ input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
		400000,
	),
	haiku: mindshubModel(
		"haiku",
		"Claude Haiku 4.5",
		{ input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
		200000,
		{ reasoning: true, thinkingLevelMap: CLAUDE_THINKING_LEVEL_MAP },
	),
	sonnet: mindshubModel(
		"sonnet",
		"Claude Sonnet 5",
		{ input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
		200000,
		{ reasoning: true, thinkingLevelMap: CLAUDE_THINKING_LEVEL_MAP },
	),
	opus: mindshubModel(
		"opus",
		"Claude Opus 5",
		{ input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
		200000,
		{
			reasoning: true,
			thinkingLevelMap: CLAUDE_THINKING_LEVEL_MAP,
		},
	),
	fable: mindshubModel(
		"fable",
		"Claude Fable 5",
		{ input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite: 12.5 },
		200000,
		{ reasoning: true, thinkingLevelMap: CLAUDE_THINKING_LEVEL_MAP },
	),
	gpt: mindshubModel("gpt", "GPT 5.6 Sol", { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 6.25 }, 272000, {
		reasoning: true,
		thinkingLevelMap: GPT_THINKING_LEVEL_MAP,
	}),
	"gpt-terra": mindshubModel(
		"gpt-terra",
		"GPT 5.6 Terra",
		{ input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: 2.5 },
		272000,
		{ reasoning: true, thinkingLevelMap: GPT_THINKING_LEVEL_MAP },
	),
	"gpt-luna": mindshubModel(
		"gpt-luna",
		"GPT 5.6 Luna",
		{ input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
		272000,
		{ reasoning: true, thinkingLevelMap: GPT_THINKING_LEVEL_MAP },
	),
	"gpt-codex": mindshubModel(
		"gpt-codex",
		"GPT 5.3 Codex",
		{ input: 1.75, output: 14.0, cacheRead: 0.18, cacheWrite: 1.75 },
		400000,
		{ reasoning: true, thinkingLevelMap: GPT_THINKING_LEVEL_MAP },
	),
	"gpt-mini": mindshubModel(
		"gpt-mini",
		"GPT 5.4 Mini",
		{ input: 0.75, output: 4.5, cacheRead: 0.08, cacheWrite: 0.75 },
		400000,
		{ reasoning: true, thinkingLevelMap: GPT_MINI_THINKING_LEVEL_MAP },
	),
	"gpt-nano": mindshubModel(
		"gpt-nano",
		"GPT 5.4 Nano",
		{ input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 },
		400000,
		{ reasoning: true, thinkingLevelMap: GPT_MINI_THINKING_LEVEL_MAP },
	),
	gemini: mindshubModel(
		"gemini",
		"Gemini 3.1 Pro Preview",
		{ input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: 0 },
		1048576,
		{ reasoning: true, thinkingLevelMap: GEMINI_THINKING_LEVEL_MAP },
	),
	"gemini-flash": mindshubModel(
		"gemini-flash",
		"Gemini 3.7 Flash",
		{ input: 0.75, output: 3.75, cacheRead: 0.08, cacheWrite: 0 },
		1048576,
		{ reasoning: true, thinkingLevelMap: GEMINI_THINKING_LEVEL_MAP },
	),
	"gemini-flash-3-6": mindshubModel(
		"gemini-flash-3-6",
		"Gemini 3.6 Flash",
		{ input: 0.75, output: 3.75, cacheRead: 0.08, cacheWrite: 0 },
		1048576,
		{ reasoning: true, thinkingLevelMap: GEMINI_THINKING_LEVEL_MAP },
	),
	// Reasons internally on every request but the level isn't adjustable through MindsHub
	// (`reasoning_efforts: null`); documented explicitly as one of the two named examples.
	kimi: mindshubModel("kimi", "Kimi K3", { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.0 }, 256000),
	deepseek: mindshubModel(
		"deepseek",
		"DeepSeek V4-Pro-0813",
		{ input: 1.32, output: 3.96, cacheRead: 0.05, cacheWrite: 1.32 },
		128000,
		{ reasoning: true, thinkingLevelMap: DEEPSEEK_THINKING_LEVEL_MAP },
	),
	"deepseek-v4-pro": mindshubModel(
		"deepseek-v4-pro",
		"DeepSeek V4 Pro",
		{ input: 1.74, output: 3.48, cacheRead: 0.15, cacheWrite: 1.74 },
		128000,
		{ reasoning: true, thinkingLevelMap: DEEPSEEK_THINKING_LEVEL_MAP },
	),
	qwen: mindshubModel(
		"qwen",
		"Qwen3.8-2.4T-A95B",
		{ input: 2.0, output: 6.0, cacheRead: 0.25, cacheWrite: 2.0 },
		256000,
		{ reasoning: true, thinkingLevelMap: QWEN_GLM_THINKING_LEVEL_MAP },
	),
	"qwen-3-7-plus": mindshubModel(
		"qwen-3-7-plus",
		"Qwen3.7 Plus",
		{ input: 0.4, output: 1.6, cacheRead: 0.08, cacheWrite: 0.4 },
		131072,
		{ reasoning: true, thinkingLevelMap: QWEN_GLM_THINKING_LEVEL_MAP },
	),
	glm: mindshubModel("glm", "GLM 5.2", { input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 1.4 }, 128000, {
		reasoning: true,
		thinkingLevelMap: QWEN_GLM_THINKING_LEVEL_MAP,
	}),
	// Grouped with the reasoning models needing a larger default max_tokens, but no adjustable
	// ladder is documented, so treated like `mindshub_air`/`kimi`: reasons, but not user-tunable.
	"muse-spark": mindshubModel(
		"muse-spark",
		"Muse Spark 1.2",
		{ input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 1.25 },
		128000,
	),
	"muse-spark-1-1": mindshubModel(
		"muse-spark-1-1",
		"Muse Spark 1.1",
		{ input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 1.25 },
		128000,
	),
	grok: mindshubModel("grok", "Grok 4.6", { input: 2.0, output: 6.0, cacheRead: 0.5, cacheWrite: 2.0 }, 256000),
	"grok-4-5": mindshubModel(
		"grok-4-5",
		"Grok 4.5",
		{ input: 2.0, output: 6.0, cacheRead: 0.3, cacheWrite: 2.0 },
		256000,
	),
} satisfies Record<string, Model<"openai-completions"> & { id: string; provider: "mindshub" }>;

export function mindshubProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "mindshub",
		name: "MindsHub",
		baseUrl: MINDSHUB_BASE_URL,
		auth: { apiKey: envApiKeyAuth("MindsHub API key", ["MINDSHUB_API_KEY"]) },
		models: Object.values(MINDSHUB_MODELS),
		api: openAICompletionsApi(),
	});
}
