/**
 * OrcaRouter model-catalog parsing and capability filtering.
 *
 * OrcaRouter serves an OpenAI-compatible catalog at GET {baseUrl}/models whose
 * entries carry `supported_endpoint_types`, `architecture.input_modalities`
 * and pricing metadata. Chat/agent, multimodal-chat, embedding, image, video
 * and rerank entries are distinguished strictly from that metadata — never by
 * guessing from a model id — and anything that does not declare a capability
 * is excluded (fail closed).
 */

import type { ProviderId } from "../types.ts";

/** Fixed OrcaRouter gateway origin. All requests hang off `{baseUrl}/…`. */
export const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1";

/**
 * Base URL for models that speak the Anthropic Messages wire format. The pi
 * Anthropic adapter points the Anthropic SDK at `model.baseUrl` and the SDK
 * appends `/v1/messages`, so this must be the gateway origin without the `/v1`
 * prefix (mirrors how OpenRouter uses `https://openrouter.ai/api`).
 */
export const ORCAROUTER_ANTHROPIC_BASE_URL = "https://api.orcarouter.ai";

export const ORCAROUTER_PROVIDER_ID = "orcarouter" satisfies ProviderId;

/** Server-side capability filter value for text chat/agent models. */
export const ORCAROUTER_CHAT_CAPABILITY = "chat";

/** Endpoint families OrcaRouter advertises per model. */
export const ORCAROUTER_CHAT_ENDPOINT_TYPES = ["openai", "openai-response", "anthropic", "gemini"] as const;

export const ORCAROUTER_EMBEDDINGS_ENDPOINT_TYPE = "embeddings";
export const ORCAROUTER_IMAGE_GENERATION_ENDPOINT_TYPE = "image-generation";
export const ORCAROUTER_VIDEO_ENDPOINT_TYPE = "openai-video";
export const ORCAROUTER_RERANK_ENDPOINT_TYPE = "jina-rerank";

/** Endpoint types that are never usable for a text chat/agent request. */
const NON_TEXT_ENDPOINT_TYPES: ReadonlySet<string> = new Set([
	ORCAROUTER_EMBEDDINGS_ENDPOINT_TYPE,
	ORCAROUTER_IMAGE_GENERATION_ENDPOINT_TYPE,
	ORCAROUTER_VIDEO_ENDPOINT_TYPE,
	ORCAROUTER_RERANK_ENDPOINT_TYPE,
]);

/** Non-text input modalities a multimodal chat entry can declare. */
export type OrcaRouterInputModality = "image" | "audio" | "video" | "file";

const KNOWN_MODALITIES: ReadonlySet<string> = new Set(["image", "audio", "video", "file"]);

/** A raw catalog entry as returned by GET {baseUrl}/models. */
export interface OrcaRouterCatalogEntry {
	id: string;
	object?: string;
	created?: number;
	owned_by?: string;
	name?: string;
	description?: string;
	supported_endpoint_types?: readonly string[];
	context_length?: number;
	max_completion_tokens?: number;
	architecture?: {
		input_modalities?: readonly string[];
		output_modalities?: readonly string[];
	};
	top_provider?: {
		context_length?: number;
		max_completion_tokens?: number;
	};
	pricing?: {
		prompt?: string | number;
		completion?: string | number;
		prompt_per_million?: string | number;
		completion_per_million?: string | number;
		/** Per-token cache-read price in $/token (OpenRouter-style), if any. */
		input_cache_read?: string | number;
		/** Per-token cache-write price in $/token (OpenRouter-style), if any. */
		input_cache_write?: string | number;
	};
}

export interface OrcaRouterCatalog {
	data: OrcaRouterCatalogEntry[];
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function toFiniteNonNegative(value: unknown): number {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
	return Number.isFinite(number) && number >= 0 ? number : 0;
}

function hasChatEndpoint(entry: OrcaRouterCatalogEntry): boolean {
	const endpointTypes = entry.supported_endpoint_types;
	if (!Array.isArray(endpointTypes)) return false;
	return endpointTypes.some(
		(endpoint) =>
			typeof endpoint === "string" && (ORCAROUTER_CHAT_ENDPOINT_TYPES as readonly string[]).includes(endpoint),
	);
}

/**
 * True when every declared endpoint type is a text-chat endpoint. An entry
 * that also lists an image-generation/embeddings/video endpoint cannot be
 * offered for plain text chat because the gateway may route it to a
 * non-text-capable upstream.
 */
function isTextChatOnly(entry: OrcaRouterCatalogEntry): boolean {
	const endpointTypes = entry.supported_endpoint_types;
	if (!Array.isArray(endpointTypes)) return false;
	return endpointTypes.every(
		(endpoint) =>
			typeof endpoint === "string" &&
			!NON_TEXT_ENDPOINT_TYPES.has(endpoint) &&
			(ORCAROUTER_CHAT_ENDPOINT_TYPES as readonly string[]).includes(endpoint),
	);
}

function declaredModalities(entry: OrcaRouterCatalogEntry): ReadonlySet<string> {
	const modalities = entry.architecture?.input_modalities;
	if (!Array.isArray(modalities)) return new Set();
	return new Set(modalities.filter((modality): modality is string => typeof modality === "string"));
}

function isMultimodalChat(entry: OrcaRouterCatalogEntry): boolean {
	const modalities = declaredModalities(entry);
	return hasChatEndpoint(entry) && Array.from(modalities).some((modality) => KNOWN_MODALITIES.has(modality));
}

function hasExactEndpoint(entry: OrcaRouterCatalogEntry, endpoint: string): boolean {
	const endpointTypes = entry.supported_endpoint_types;
	if (!Array.isArray(endpointTypes)) return false;
	return endpointTypes.length > 0 && endpointTypes.every((entryEndpoint) => entryEndpoint === endpoint);
}

function parseName(entry: OrcaRouterCatalogEntry, fallback: string): string {
	return isNonEmptyString(entry.name) ? (entry.name as string) : fallback;
}

function parseModalityCount(entry: OrcaRouterCatalogEntry): number {
	const count = entry.context_length ?? entry.top_provider?.context_length;
	const numeric = typeof count === "number" ? count : Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? numeric : 4096;
}

function parseMaxTokens(entry: OrcaRouterCatalogEntry): number {
	const count = entry.max_completion_tokens ?? entry.top_provider?.max_completion_tokens;
	const numeric = typeof count === "number" ? count : Number.NaN;
	return Number.isFinite(numeric) && numeric > 0 ? numeric : 4096;
}

function parseInputModalities(entry: OrcaRouterCatalogEntry): ("text" | "image")[] {
	const modalities = declaredModalities(entry);
	const input: ("text" | "image")[] = ["text"];
	if (modalities.has("image")) input.push("image");
	return input;
}

function parseCostPerMillion(entry: OrcaRouterCatalogEntry): { input: number; output: number } {
	const pricing = entry.pricing;
	if (!pricing) return { input: 0, output: 0 };
	// Prices are published in $/M tokens (prompt_per_million/completion_per_million)
	// or $/token (prompt/completion). Normalize both to $/M tokens.
	return {
		input: toFiniteNonNegative(pricing.prompt_per_million ?? pricing.prompt),
		output: toFiniteNonNegative(pricing.completion_per_million ?? pricing.completion),
	};
}

export interface OrcaRouterChatModelInit {
	id: string;
	provider: "orcarouter";
	api: "openai-completions" | "anthropic-messages";
	name: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	endpointTypes: readonly string[];
	inputModalities: readonly string[];
	contextWindow: number;
	maxTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	catalogId: string;
}

function chooseChatApi(entry: OrcaRouterCatalogEntry): "openai-completions" | "anthropic-messages" {
	// Anthropic-vendor models use the Anthropic Messages adapter; everything else
	// (including OrcaRouter's own routing models, which expose both formats)
	// uses OpenAI chat completions.
	const id = entry.id ?? "";
	const endpointTypes = entry.supported_endpoint_types;
	if (id.startsWith("anthropic/") && Array.isArray(endpointTypes) && endpointTypes.includes("anthropic")) {
		return "anthropic-messages";
	}
	return "openai-completions";
}

/**
 * Parse a raw catalog entry into a chat-capable model. Text chat uses
 * `?capability=chat` on the wire; this filter additionally rejects entries
 * whose endpoint set includes a non-text endpoint and entries that declare no
 * chat endpoint. Model ids are preserved verbatim (`vendor/model`).
 */
export function toChatModel(entry: OrcaRouterCatalogEntry): OrcaRouterChatModelInit | undefined {
	if (!isNonEmptyString(entry.id) || !hasChatEndpoint(entry) || !isTextChatOnly(entry)) return undefined;
	const id = entry.id as string;
	const fallbackName = id.replace(/^[^/]+\//u, "");
	const api = chooseChatApi(entry);
	return {
		id,
		provider: "orcarouter",
		api,
		name: parseName(entry, fallbackName),
		baseUrl: api === "anthropic-messages" ? ORCAROUTER_ANTHROPIC_BASE_URL : ORCAROUTER_BASE_URL,
		reasoning: false,
		input: parseInputModalities(entry),
		endpointTypes: Array.isArray(entry.supported_endpoint_types) ? [...entry.supported_endpoint_types] : [],
		inputModalities: Array.from(declaredModalities(entry)),
		contextWindow: parseModalityCount(entry),
		maxTokens: parseMaxTokens(entry),
		cost: { ...parseCostPerMillion(entry), cacheRead: 0, cacheWrite: 0 },
		catalogId: id,
	};
}

/**
 * Text-chat-only models: capable of text chat/agent requests. Requires a chat
 * endpoint and excludes any entry that also advertises image/video/embedding/
 * rerank generation.
 */
export function orcaRouterTextChatModels(entries: readonly OrcaRouterCatalogEntry[]): OrcaRouterChatModelInit[] {
	const models: OrcaRouterChatModelInit[] = [];
	for (const entry of entries) {
		const model = toChatModel(entry);
		if (model) models.push(model);
	}
	return models;
}

/**
 * Multimodal chat models for a specific input modality. Each entry must (1) be
 * a text-chat model and (2) explicitly declare `modality` in
 * `architecture.input_modalities`. Entries that omit the field fail closed.
 */
export function orcaRouterMultimodalChatModels(
	entries: readonly OrcaRouterCatalogEntry[],
	modality: OrcaRouterInputModality,
): OrcaRouterChatModelInit[] {
	const models: OrcaRouterChatModelInit[] = [];
	for (const entry of entries) {
		const chat = toChatModel(entry);
		if (!chat) continue;
		if (!declaredModalities(entry).has(modality)) continue;
		models.push(chat);
	}
	return models;
}

/** Embedding models: strict endpoint match on `embeddings`. */
export function orcaRouterEmbeddingModels(entries: readonly OrcaRouterCatalogEntry[]): OrcaRouterCatalogEntry[] {
	return entries.filter((entry) => hasExactEndpoint(entry, ORCAROUTER_EMBEDDINGS_ENDPOINT_TYPE));
}

/** Image-generation models: strict endpoint match on `image-generation`. */
export function orcaRouterImageGenerationModels(entries: readonly OrcaRouterCatalogEntry[]): OrcaRouterCatalogEntry[] {
	return entries.filter((entry) => hasExactEndpoint(entry, ORCAROUTER_IMAGE_GENERATION_ENDPOINT_TYPE));
}

/** Video-generation models: strict endpoint match on `openai-video`. */
export function orcaRouterVideoModels(entries: readonly OrcaRouterCatalogEntry[]): OrcaRouterCatalogEntry[] {
	return entries.filter((entry) => hasExactEndpoint(entry, ORCAROUTER_VIDEO_ENDPOINT_TYPE));
}

/** Rerank models: strict endpoint match on `jina-rerank`. */
export function orcaRouterRerankModels(entries: readonly OrcaRouterCatalogEntry[]): OrcaRouterCatalogEntry[] {
	return entries.filter((entry) => hasExactEndpoint(entry, ORCAROUTER_RERANK_ENDPOINT_TYPE));
}

/**
 * Parse a GET {baseUrl}/models response body. The response is a top-level
 * `{ data: [...] }` object; any other shape is rejected.
 */
export function parseOrcaRouterCatalog(value: unknown): OrcaRouterCatalog {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("OrcaRouter catalog response must be a JSON object");
	}
	const data = (value as { data?: unknown }).data;
	if (!Array.isArray(data)) {
		throw new TypeError("OrcaRouter catalog response is missing a data array");
	}
	const entries: OrcaRouterCatalogEntry[] = [];
	for (const item of data) {
		if (typeof item !== "object" || item === null) continue;
		const entry = item as OrcaRouterCatalogEntry;
		if (typeof entry.id === "string" && entry.id.length > 0) entries.push(entry);
	}
	return { data: entries };
}

/** True when a parsed model set actually came from a catalog (used by tests). */
export function isMultimodalChatEntry(entry: OrcaRouterCatalogEntry): boolean {
	return isMultimodalChat(entry);
}
