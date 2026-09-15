/**
 * OrcaRouter model discovery.
 *
 * Live discovery reads the configured inference origin's `GET /v1/models`
 * (default `https://api.orcarouter.ai/v1`) with the user's own OrcaRouter key,
 * so the list reflects exactly what that workspace can call. The request is
 * bounded in time, bytes, and item count; a catalog failure never removes the
 * provider, it falls back to the verified seed below.
 *
 * When a live entry matches a verified seed entry by id, the seed's verified
 * metadata (reasoning ladder, declared modalities, context) is retained rather
 * than erased by absent fields in the catalog response.
 */

import type { Api, Model, ProviderId, ThinkingLevelMap } from "../types.ts";
import {
	capabilityQueryValue,
	ORCAROUTER_CATALOG_MAX_BYTES,
	ORCAROUTER_CATALOG_MAX_ITEMS,
	ORCAROUTER_CATALOG_TIMEOUT_MS,
	ORCAROUTER_TEXT_ENDPOINT_TYPES,
	type OrcaRouterCapability,
	type OrcaRouterCatalog,
	type OrcaRouterModality,
	type OrcaRouterModelRecord,
	parseOrcaRouterCatalog,
} from "./capabilities.ts";

/** Default inference origin. Never derived from the auth origin. */
export const ORCAROUTER_DEFAULT_API_BASE_URL = "https://api.orcarouter.ai/v1";

/**
 * Verified cold-start catalog. These ids come from the OrcaRouter provider seed
 * list; they exist so a fresh installation is usable while the catalog request
 * is slow, offline, or rejected, and so a catalog outage cannot advertise an
 * empty model list. Live discovery replaces this list when it succeeds.
 *
 * `openai/gpt-5.5` keeps its verified reasoning ladder; the other entries are
 * text-only chat models with the modalities OrcaRouter documents for them.
 */
export const ORCAROUTER_FALLBACK_MODELS: OrcaRouterCatalog = [
	{
		id: "openai/gpt-5.5",
		contextLength: 400_000,
		maxCompletionTokens: 128_000,
		inputModalities: ["text", "image"],
		endpointTypes: [...ORCAROUTER_TEXT_ENDPOINT_TYPES],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
	},
	{
		id: "anthropic/claude-opus-4.8",
		contextLength: 200_000,
		maxCompletionTokens: 64_000,
		inputModalities: ["text", "image"],
		endpointTypes: [...ORCAROUTER_TEXT_ENDPOINT_TYPES],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
	},
	{
		id: "google/gemini-3.5-flash",
		contextLength: 1_000_000,
		maxCompletionTokens: 65_536,
		inputModalities: ["text", "image"],
		endpointTypes: [...ORCAROUTER_TEXT_ENDPOINT_TYPES],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
	},
	{
		id: "deepseek/deepseek-v4-pro",
		contextLength: 1_048_576,
		maxCompletionTokens: 384_000,
		inputModalities: ["text"],
		endpointTypes: ["openai", "openai-response"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
	},
	{
		id: "orcarouter/auto",
		contextLength: 400_000,
		maxCompletionTokens: 128_000,
		inputModalities: ["text"],
		endpointTypes: [...ORCAROUTER_TEXT_ENDPOINT_TYPES],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
	},
];

const FALLBACK_BY_ID = new Map(ORCAROUTER_FALLBACK_MODELS.map((model) => [model.id, model]));

/**
 * Reasoning effort ladder verified for `openai/gpt-5.5`. `minimal` and `max`
 * are explicitly unsupported so pi does not send them; the low/medium/high/xhigh
 * levels are preserved.
 */
const GPT_5_5_THINKING_LEVELS: ThinkingLevelMap = {
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: null,
};

/** Reasoning levels pi maps onto OrcaRouter's OpenAI-compatible `reasoning_effort`. */
const DEFAULT_THINKING_LEVELS: ThinkingLevelMap = {
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: null,
};

function thinkingLevelsFor(id: string, reasoning: boolean): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	return id === "openai/gpt-5.5" ? GPT_5_5_THINKING_LEVELS : DEFAULT_THINKING_LEVELS;
}

/**
 * pi API implementation for an OrcaRouter route. Vendor-aware so Anthropic and
 * Google models keep their native adapters (prompt caching, thinking) while
 * everything else uses the OpenAI-compatible surface.
 */
export type OrcaRouterApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export function selectOrcaRouterApi(record: OrcaRouterModelRecord): OrcaRouterApi | undefined {
	const vendor = record.id.includes("/") ? record.id.slice(0, record.id.indexOf("/")) : "";
	const has = (type: string) => record.endpointTypes.includes(type);
	if (vendor === "anthropic" && has("anthropic")) return "anthropic-messages";
	if ((vendor === "google" || vendor === "gemini") && has("gemini")) return "google-generative-ai";
	if (has("openai")) return "openai-completions";
	if (has("openai-response")) return "openai-responses";
	if (has("anthropic")) return "anthropic-messages";
	if (has("gemini")) return "google-generative-ai";
	return undefined;
}

/** Retain verified seed metadata that the catalog response does not republish. */
export function mergeVerifiedMetadata(record: OrcaRouterModelRecord): OrcaRouterModelRecord {
	const verified = FALLBACK_BY_ID.get(record.id);
	if (!verified) return record;
	return {
		...record,
		name: record.name ?? verified.name,
		contextLength: record.contextLength ?? verified.contextLength,
		maxCompletionTokens: record.maxCompletionTokens ?? verified.maxCompletionTokens,
		inputModalities: record.inputModalities ?? verified.inputModalities,
		reasoning: record.reasoning || verified.reasoning,
		cost: record.cost.input === 0 && record.cost.output === 0 ? verified.cost : record.cost,
	};
}

/** Convert a catalog record into pi's `Model` shape. Ids are preserved verbatim. */
export function toOrcaRouterModel(
	record: OrcaRouterModelRecord,
	options: { providerId: ProviderId; baseUrl: string },
): Model<Api> | undefined {
	const api = selectOrcaRouterApi(record);
	if (!api) return undefined;
	const verified = mergeVerifiedMetadata(record);
	const input: ("text" | "image")[] = ["text"];
	if (verified.inputModalities?.includes("image")) input.push("image");
	const contextWindow = verified.contextLength ?? 128_000;
	return {
		id: verified.id,
		name: verified.name ?? verified.id,
		api,
		provider: options.providerId,
		baseUrl: options.baseUrl,
		reasoning: verified.reasoning,
		thinkingLevelMap: thinkingLevelsFor(verified.id, verified.reasoning),
		input,
		cost: verified.cost,
		contextWindow,
		maxTokens: Math.min(verified.maxCompletionTokens ?? 8_192, contextWindow),
	};
}

export interface FetchOrcaRouterCatalogOptions {
	/** Inference origin, including the `/v1` suffix. */
	baseUrl: string;
	/** Bearer credential. Absent means an unauthenticated read. */
	apiKey?: string;
	capability: OrcaRouterCapability;
	modality?: OrcaRouterModality;
	signal?: AbortSignal;
	/** Injectable for tests. Defaults to the global fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * Read the workspace-scoped catalog. Bounded by timeout, response bytes, and
 * item count. Throws on transport/HTTP failure so callers keep their previous
 * catalog; never returns a partial list disguised as success.
 */
export async function fetchOrcaRouterCatalog(options: FetchOrcaRouterCatalogOptions): Promise<OrcaRouterCatalog> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const url = new URL("models", options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
	const capability = capabilityQueryValue(options.capability);
	if (capability) url.searchParams.set("capability", capability);
	if (options.modality) url.searchParams.set("modality", options.modality);

	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error("OrcaRouter model catalog timed out")),
		ORCAROUTER_CATALOG_TIMEOUT_MS,
	);
	const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

	try {
		const headers: Record<string, string> = { accept: "application/json" };
		if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
		const response = await fetchImpl(url, { method: "GET", headers, signal });
		if (!response.ok) {
			throw new Error(`OrcaRouter model catalog failed (HTTP ${response.status})`);
		}
		const text = await readBoundedText(response);
		return parseOrcaRouterCatalog(JSON.parse(text));
	} finally {
		clearTimeout(timeout);
	}
}

/** Read at most `ORCAROUTER_CATALOG_MAX_BYTES` so a catalog cannot exhaust memory. */
async function readBoundedText(response: Response): Promise<string> {
	if (!response.body) return response.text();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > ORCAROUTER_CATALOG_MAX_BYTES) {
				throw new Error("OrcaRouter model catalog exceeded the size limit");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

/** Convert a whole catalog, dropping entries pi cannot route. */
export function toOrcaRouterModels(
	catalog: OrcaRouterCatalog,
	options: { providerId: ProviderId; baseUrl: string },
): Model<Api>[] {
	const models: Model<Api>[] = [];
	for (const record of catalog.slice(0, ORCAROUTER_CATALOG_MAX_ITEMS)) {
		const model = toOrcaRouterModel(record, options);
		if (model) models.push(model);
	}
	return models;
}
