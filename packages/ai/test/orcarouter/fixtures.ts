/**
 * Shared OrcaRouter catalog fixtures for capability-filter tests.
 *
 * These fixtures are realistic slices of the live catalog shape served by
 * `GET https://api.orcarouter.ai/v1/models` and cover every capability the
 * filter layer must separate: text-only chat, image-input chat, embeddings,
 * image generation, video generation, and rerank. Model ids are representative
 * vendor/model namespaces and are used for filtering logic only — never as a
 * hardcoded fallback model list.
 */

import type { OrcaRouterCatalogEntry } from "../../src/orcarouter/capabilities.ts";

/** Text-only chat model (declares no input modalities). */
const textChat: OrcaRouterCatalogEntry = {
	id: "orcarouter/fusion",
	object: "model",
	created: 0,
	owned_by: "orcarouter",
	name: "OrcaRouter Fusion",
	supported_endpoint_types: ["openai", "openai-response", "anthropic", "gemini"],
	context_length: 1_000_000,
	max_completion_tokens: 65536,
	pricing: { prompt: "0", completion: "0" },
};

/** Image-input chat model (declares image in architecture.input_modalities). */
const imageChat: OrcaRouterCatalogEntry = {
	id: "google/gemini-3-flash",
	object: "model",
	created: 1626777600,
	owned_by: "custom",
	name: "Google: Gemini 3 Flash",
	description: "multimodal test model",
	supported_endpoint_types: ["openai", "gemini"],
	context_length: 1_048_576,
	max_completion_tokens: 65536,
	architecture: {
		input_modalities: ["text", "image"],
		output_modalities: ["text"],
	},
	pricing: { prompt: "0", completion: "0" },
};

/** Audio+text chat model (declares audio modality). */
const audioChat: OrcaRouterCatalogEntry = {
	id: "openai/audio-chat-model",
	object: "model",
	created: 0,
	owned_by: "custom",
	name: "Audio chat model",
	supported_endpoint_types: ["openai"],
	context_length: 128_000,
	architecture: { input_modalities: ["text", "audio"], output_modalities: ["text"] },
};

/** Chat-capable entry that ALSO lists an image-generation endpoint. */
const mixedChatImageGen: OrcaRouterCatalogEntry = {
	id: "vendor/dual-mode",
	object: "model",
	created: 0,
	owned_by: "custom",
	name: "Dual mode model",
	supported_endpoint_types: ["openai", "image-generation"],
	context_length: 128_000,
};

/** Chat-capable entry that ALSO lists an openai-video endpoint. */
const mixedChatVideo: OrcaRouterCatalogEntry = {
	id: "vendor/chat-and-video",
	object: "model",
	created: 0,
	owned_by: "custom",
	name: "Chat and video model",
	supported_endpoint_types: ["openai", "openai-video"],
};

/** Chat-capable entry that ALSO lists a jina-rerank endpoint. */
const mixedChatRerank: OrcaRouterCatalogEntry = {
	id: "vendor/chat-and-rerank",
	object: "model",
	created: 0,
	owned_by: "custom",
	name: "Chat and rerank model",
	supported_endpoint_types: ["openai", "jina-rerank"],
};

/** Embedding-only entry. */
const embedding: OrcaRouterCatalogEntry = {
	id: "openai/text-embedding-3-small",
	object: "model",
	created: 0,
	owned_by: "OpenAI",
	name: "OpenAI: text-embedding-3-small",
	supported_endpoint_types: ["embeddings"],
	context_length: 8191,
	pricing: { prompt: "0", completion: "0" },
};

/** Image-generation-only entry. */
const imageGeneration: OrcaRouterCatalogEntry = {
	id: "openai/gpt-image-1",
	object: "model",
	created: 0,
	owned_by: "OpenAI",
	name: "OpenAI: GPT Image 1",
	supported_endpoint_types: ["image-generation"],
};

/** Video-generation-only entry. */
const videoGeneration: OrcaRouterCatalogEntry = {
	id: "kling/kling-v2-1-master",
	object: "model",
	created: 0,
	owned_by: "custom",
	name: "Kling: Kling V2.1 Master",
	supported_endpoint_types: ["openai-video"],
};

/** Rerank-only entry. */
const rerank: OrcaRouterCatalogEntry = {
	id: "vendor/jina-reranker",
	object: "model",
	created: 0,
	owned_by: "custom",
	name: "Vendor: Jina Reranker",
	supported_endpoint_types: ["jina-rerank"],
};

/** Anthropic-endpoint chat model. */
const anthropicChat: OrcaRouterCatalogEntry = {
	id: "anthropic/claude-haiku-4-5",
	object: "model",
	created: 0,
	owned_by: "Anthropic",
	name: "Anthropic: Claude Haiku 4.5",
	supported_endpoint_types: ["anthropic"],
	context_length: 200_000,
	architecture: { input_modalities: ["text"], output_modalities: ["text"] },
};

/**
 * A realistic catalog fixture containing every capability class the filters
 * must separate.
 */
export const ORCAROUTER_CAPABILITY_FIXTURE: readonly OrcaRouterCatalogEntry[] = [
	textChat,
	imageChat,
	audioChat,
	mixedChatImageGen,
	mixedChatVideo,
	mixedChatRerank,
	embedding,
	imageGeneration,
	videoGeneration,
	rerank,
	anthropicChat,
];

/** Text-chat fixture with a subset of the real live-catalog model ids. */
export const ORCAROUTER_TEXT_CHAT_EXPECTED_IDS = new Set([
	"orcarouter/fusion",
	"google/gemini-3-flash",
	"openai/audio-chat-model",
	"anthropic/claude-haiku-4-5",
]);

/** Image-input multimodal chat fixture. */
export const ORCAROUTER_IMAGE_CHAT_EXPECTED_IDS = new Set(["google/gemini-3-flash"]);

/** Text-only entries must NOT include mixed-capability, embedding, image, video or rerank models. */
export const ORCAROUTER_NON_TEXT_EXPECTED_EXCLUDED_IDS = new Set([
	"vendor/dual-mode",
	"vendor/chat-and-video",
	"vendor/chat-and-rerank",
	"openai/text-embedding-3-small",
	"openai/gpt-image-1",
	"kling/kling-v2-1-master",
	"vendor/jina-reranker",
]);

export const ORCAROUTER_EMBEDDING_EXPECTED_IDS = new Set(["openai/text-embedding-3-small"]);
export const ORCAROUTER_IMAGE_GENERATION_EXPECTED_IDS = new Set(["openai/gpt-image-1"]);
export const ORCAROUTER_VIDEO_EXPECTED_IDS = new Set(["kling/kling-v2-1-master"]);
export const ORCAROUTER_RERANK_EXPECTED_IDS = new Set(["vendor/jina-reranker"]);
