import { describe, expect, it } from "vitest";
import {
	isMultimodalChatEntry,
	ORCAROUTER_BASE_URL,
	type OrcaRouterCatalogEntry,
	orcaRouterEmbeddingModels,
	orcaRouterImageGenerationModels,
	orcaRouterMultimodalChatModels,
	orcaRouterRerankModels,
	orcaRouterTextChatModels,
	orcaRouterVideoModels,
	parseOrcaRouterCatalog,
	toChatModel,
} from "../src/orcarouter/capabilities.ts";
import {
	ORCAROUTER_CAPABILITY_FIXTURE,
	ORCAROUTER_EMBEDDING_EXPECTED_IDS,
	ORCAROUTER_IMAGE_CHAT_EXPECTED_IDS,
	ORCAROUTER_IMAGE_GENERATION_EXPECTED_IDS,
	ORCAROUTER_NON_TEXT_EXPECTED_EXCLUDED_IDS,
	ORCAROUTER_RERANK_EXPECTED_IDS,
	ORCAROUTER_TEXT_CHAT_EXPECTED_IDS,
	ORCAROUTER_VIDEO_EXPECTED_IDS,
} from "./orcarouter/fixtures.ts";

function ids(entries: readonly { id: string }[]): string[] {
	return entries.map((entry) => entry.id).sort();
}

describe("OrcaRouter catalog parsing", () => {
	it("parses the OpenRouter-style { data: [] } envelope and preserves model ids verbatim", () => {
		const catalog = parseOrcaRouterCatalog({ data: [...ORCAROUTER_CAPABILITY_FIXTURE] });
		expect(catalog.data.map((entry) => entry.id)).toContain("google/gemini-3-flash");
	});

	it("rejects envelopes without a data array", () => {
		expect(() => parseOrcaRouterCatalog({ models: [] })).toThrow(/data array/);
		expect(() => parseOrcaRouterCatalog(null)).toThrow(/JSON object/);
	});
});

describe("OrcaRouter chat capability filter", () => {
	it("keeps only chat-capable entries and never entries with image/video/embedding/rerank endpoints", () => {
		const textModels = orcaRouterTextChatModels(ORCAROUTER_CAPABILITY_FIXTURE);
		const textIds = new Set(ids(textModels));
		for (const expected of ORCAROUTER_TEXT_CHAT_EXPECTED_IDS) {
			expect(textIds.has(expected)).toBe(true);
		}
		for (const excluded of ORCAROUTER_NON_TEXT_EXPECTED_EXCLUDED_IDS) {
			expect(textIds.has(excluded)).toBe(false);
		}
	});

	it("maps catalog entries onto a pi model shape with a fixed gateway base URL", () => {
		const model = toChatModel({
			id: "google/gemini-3-flash",
			supported_endpoint_types: ["openai", "gemini"],
			architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
			context_length: 1_048_576,
			max_completion_tokens: 65_536,
			pricing: { prompt_per_million: "0.75", completion_per_million: "3.75" },
		});
		// openai-completions models use the /v1 base; anthropic-messages models use the origin.
		expect(model?.baseUrl).toBe(ORCAROUTER_BASE_URL);
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.contextWindow).toBe(1_048_576);
		expect(model?.maxTokens).toBe(65_536);
		const anthropicModel = toChatModel({
			id: "anthropic/claude-haiku-4-5",
			supported_endpoint_types: ["anthropic"],
			architecture: { input_modalities: ["text"], output_modalities: ["text"] },
			context_length: 200_000,
		});
		expect(anthropicModel?.api).toBe("anthropic-messages");
		expect(anthropicModel?.baseUrl).toBe("https://api.orcarouter.ai");
	});

	it("does not guess capabilities from model ids: dual-mode, video, rerank and embeddings are excluded", () => {
		const textIds = new Set(ids(orcaRouterTextChatModels(ORCAROUTER_CAPABILITY_FIXTURE)));
		for (const excluded of ["vendor/dual-mode", "vendor/chat-and-video", "vendor/chat-and-rerank"]) {
			expect(textIds.has(excluded)).toBe(false);
		}
	});
});

describe("OrcaRouter multimodal chat filter (fail closed)", () => {
	it("keeps chat models that explicitly declare the requested input modality", () => {
		const imageModels = orcaRouterMultimodalChatModels(ORCAROUTER_CAPABILITY_FIXTURE, "image");
		const imageIds = new Set(ids(imageModels));
		for (const expected of ORCAROUTER_IMAGE_CHAT_EXPECTED_IDS) {
			expect(imageIds.has(expected)).toBe(true);
		}
	});

	it("excludes chat models that omit the modality declaration (fail closed)", () => {
		const imageModels = orcaRouterMultimodalChatModels(ORCAROUTER_CAPABILITY_FIXTURE, "image");
		const imageIds = new Set(ids(imageModels));
		// Text-only chat entries declare no input_modalities -> excluded.
		for (const excluded of ["orcarouter/fusion", "anthropic/claude-haiku-4-5"]) {
			expect(imageIds.has(excluded)).toBe(false);
		}
	});

	it("separates audio modality from image modality", () => {
		const audioIds = new Set(ids(orcaRouterMultimodalChatModels(ORCAROUTER_CAPABILITY_FIXTURE, "audio")));
		const imageIds = new Set(ids(orcaRouterMultimodalChatModels(ORCAROUTER_CAPABILITY_FIXTURE, "image")));
		expect(audioIds.has("openai/audio-chat-model")).toBe(true);
		expect(imageIds.has("openai/audio-chat-model")).toBe(false);
		expect(imageIds.has("google/gemini-3-flash")).toBe(true);
	});
});

describe("OrcaRouter capability-specific filters", () => {
	it("filters embeddings by strict embeddings endpoint match", () => {
		const embeddingIds = new Set(ids(orcaRouterEmbeddingModels(ORCAROUTER_CAPABILITY_FIXTURE)));
		expect(embeddingIds.size).toBe(1);
		for (const expected of ORCAROUTER_EMBEDDING_EXPECTED_IDS) expect(embeddingIds.has(expected)).toBe(true);
	});

	it("filters image generation by strict image-generation endpoint match", () => {
		const imageIds = new Set(ids(orcaRouterImageGenerationModels(ORCAROUTER_CAPABILITY_FIXTURE)));
		expect(imageIds.size).toBe(1);
		for (const expected of ORCAROUTER_IMAGE_GENERATION_EXPECTED_IDS) expect(imageIds.has(expected)).toBe(true);
	});

	it("filters video generation by strict openai-video endpoint match", () => {
		const videoIds = new Set(ids(orcaRouterVideoModels(ORCAROUTER_CAPABILITY_FIXTURE)));
		expect(videoIds.size).toBe(1);
		for (const expected of ORCAROUTER_VIDEO_EXPECTED_IDS) expect(videoIds.has(expected)).toBe(true);
	});

	it("filters rerank by strict jina-rerank endpoint match", () => {
		const rerankIds = new Set(ids(orcaRouterRerankModels(ORCAROUTER_CAPABILITY_FIXTURE)));
		expect(rerankIds.size).toBe(1);
		for (const expected of ORCAROUTER_RERANK_EXPECTED_IDS) expect(rerankIds.has(expected)).toBe(true);
	});
});

describe("OrcaRouter multimodal guard helper", () => {
	it("classifies only chat entries that declare a non-text modality as multimodal", () => {
		const fixture: OrcaRouterCatalogEntry[] = [
			{ id: "a/img", supported_endpoint_types: ["openai"], architecture: { input_modalities: ["text", "image"] } },
			{ id: "b/text", supported_endpoint_types: ["openai"] },
			{ id: "c/gen", supported_endpoint_types: ["image-generation"] },
		];
		expect(isMultimodalChatEntry(fixture[0]!)).toBe(true);
		expect(isMultimodalChatEntry(fixture[1]!)).toBe(false);
		expect(isMultimodalChatEntry(fixture[2]!)).toBe(false);
	});
});
