/**
 * Gloo AI model catalog.
 *
 * Lives outside `models.generated.ts` so upstream regenerations
 * (`npm run generate-models`) don't wipe out the Gloo entries on rebase.
 * `models.ts` merges this map into the live registry alongside MODELS.
 *
 * Catalog is the same set of 23 models seeded by the glooai/opencode fork
 * (verified 2026-04-27 against `platform.ai.gloo.com/ai/v2/models`).
 *
 * Notes:
 * - `baseUrl` resolves at module load from `GLOO_BASE_URL` so tests and
 *   `gloo-local-dev` can swap to localhost without editing this file.
 * - `cost` is zero across the board because Gloo customers are billed via
 *   their platform contract, not per-token. Pi-ai's calculateCost therefore
 *   returns zero — that's correct, not a placeholder.
 * - Pi-ai's `Model` type doesn't have a `toolcall` flag, so the
 *   "platform rejects tools for this model" list lives next to the wrapper
 *   in `providers/gloo.ts` (`GLOO_TOOLCALL_BLOCKLIST`).
 */

import type { Model } from "./types.js";

function glooBaseUrl(): string {
	return `${(process.env.GLOO_BASE_URL ?? "https://platform.ai.gloo.com").replace(/\/$/, "")}/ai/v2`;
}

interface GlooModelDef {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	image: boolean;
}

const GLOO_MODEL_DEFS: GlooModelDef[] = [
	// Anthropic
	{
		id: "gloo-anthropic-claude-haiku-4.5",
		name: "Claude Haiku 4.5",
		contextWindow: 200_000,
		maxTokens: 8_192,
		reasoning: false,
		image: true,
	},
	{
		id: "gloo-anthropic-claude-sonnet-4",
		name: "Claude Sonnet 4",
		contextWindow: 200_000,
		maxTokens: 16_384,
		reasoning: true,
		image: true,
	},
	{
		id: "gloo-anthropic-claude-sonnet-4.5",
		name: "Claude Sonnet 4.5",
		contextWindow: 200_000,
		maxTokens: 16_384,
		reasoning: true,
		image: true,
	},
	{
		id: "gloo-anthropic-claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		contextWindow: 200_000,
		maxTokens: 16_384,
		reasoning: true,
		image: true,
	},
	{
		id: "gloo-anthropic-claude-opus-4.5",
		name: "Claude Opus 4.5",
		contextWindow: 200_000,
		maxTokens: 32_768,
		reasoning: true,
		image: true,
	},
	{
		id: "gloo-anthropic-claude-opus-4.6",
		name: "Claude Opus 4.6",
		contextWindow: 200_000,
		maxTokens: 32_768,
		reasoning: true,
		image: true,
	},
	// Google
	{
		id: "gloo-google-gemini-2.5-flash-lite",
		name: "Gemini 2.5 Flash Lite",
		contextWindow: 1_000_000,
		maxTokens: 8_192,
		reasoning: false,
		image: true,
	},
	{
		id: "gloo-google-gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		contextWindow: 1_000_000,
		maxTokens: 8_192,
		reasoning: true,
		image: true,
	},
	{
		id: "gloo-google-gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		contextWindow: 1_000_000,
		maxTokens: 16_384,
		reasoning: true,
		image: true,
	},
	// OpenAI
	{
		id: "gloo-openai-gpt-5-nano",
		name: "GPT-5 Nano",
		contextWindow: 128_000,
		maxTokens: 16_384,
		reasoning: false,
		image: true,
	},
	{
		id: "gloo-openai-gpt-5-mini",
		name: "GPT-5 Mini",
		contextWindow: 128_000,
		maxTokens: 16_384,
		reasoning: true,
		image: true,
	},
	{
		id: "gloo-openai-gpt-4.1-mini",
		name: "GPT-4.1 Mini",
		contextWindow: 1_000_000,
		maxTokens: 32_768,
		reasoning: false,
		image: true,
	},
	{
		id: "gloo-openai-gpt-4.1",
		name: "GPT-4.1",
		contextWindow: 1_000_000,
		maxTokens: 32_768,
		reasoning: false,
		image: true,
	},
	{
		id: "gloo-openai-gpt-5.2",
		name: "GPT-5.2",
		contextWindow: 128_000,
		maxTokens: 32_768,
		reasoning: true,
		image: true,
	},
	{
		id: "gloo-openai-gpt-5.4",
		name: "GPT-5.4",
		contextWindow: 128_000,
		maxTokens: 32_768,
		reasoning: true,
		image: true,
	},
	{
		id: "gloo-openai-gpt-5.2-pro",
		name: "GPT-5.2 Pro",
		contextWindow: 128_000,
		maxTokens: 32_768,
		reasoning: true,
		image: true,
	},
	// Open Source — toolcall blocklist enforced in providers/gloo.ts
	{
		id: "gloo-meta-llama-3.1-8b-instruct",
		name: "Llama 3.1 8B Instruct",
		contextWindow: 128_000,
		maxTokens: 8_192,
		reasoning: false,
		image: false,
	},
	{
		id: "gloo-meta-llama-4-maverick",
		name: "Meta Llama 4 Maverick",
		contextWindow: 128_000,
		maxTokens: 16_384,
		reasoning: true,
		image: true,
	},
	{
		id: "gloo-deepseek-chat-v3.1",
		name: "DeepSeek Chat V3.1",
		contextWindow: 128_000,
		maxTokens: 8_192,
		reasoning: false,
		image: false,
	},
	{
		id: "gloo-deepseek-v3.2",
		name: "DeepSeek V3.2",
		contextWindow: 128_000,
		maxTokens: 8_192,
		reasoning: true,
		image: false,
	},
	{
		id: "gloo-deepseek-r1",
		name: "DeepSeek R1",
		contextWindow: 128_000,
		maxTokens: 8_192,
		reasoning: true,
		image: false,
	},
	{
		id: "gloo-openai-gpt-oss-120b",
		name: "GPT OSS 120B",
		contextWindow: 128_000,
		maxTokens: 16_384,
		reasoning: true,
		image: false,
	},
];

function buildGlooModel(def: GlooModelDef): Model<"gloo-openai-completions"> {
	return {
		id: def.id,
		name: def.name,
		api: "gloo-openai-completions",
		provider: "gloo",
		baseUrl: glooBaseUrl(),
		reasoning: def.reasoning,
		input: def.image ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: def.contextWindow,
		maxTokens: def.maxTokens,
	};
}

const glooEntries: Record<string, Model<"gloo-openai-completions">> = {};
for (const def of GLOO_MODEL_DEFS) {
	glooEntries[def.id] = buildGlooModel(def);
}

export const MODELS_GLOO = {
	gloo: glooEntries,
} as const;

export type GlooModelId = (typeof GLOO_MODEL_DEFS)[number]["id"];
