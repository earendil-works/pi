/**
 * OrcaRouter model catalog parsing and per-capability filtering.
 *
 * The single source of truth is the configured OrcaRouter origin's
 * `GET /v1/models` response (default `https://api.orcarouter.ai/v1`). Model ids
 * are preserved verbatim, including the `vendor/model` namespace.
 *
 * Capability rules never guess from a model name:
 * - text chat: `capability=chat` plus a text-capable `supported_endpoint_types`
 *   entry, excluding media/embedding/rerank-only routes;
 * - multimodal chat: text chat *and* an explicit `architecture.input_modalities`
 *   declaration for the requested modality. An entry that declares nothing is
 *   not eligible for a modality it never claimed (fail closed);
 * - embedding / image generation / video / rerank: strict endpoint-type match.
 *
 * The `pricing` block is quoted in USD per token; pi's `ModelCost` is USD per
 * million tokens.
 */

/** Endpoint types this provider can actually speak through pi's adapters. */
export const ORCAROUTER_TEXT_ENDPOINT_TYPES = ["openai", "openai-response", "anthropic", "gemini"] as const;

/** Endpoint types that identify a non-text-only route. */
const NON_TEXT_ENDPOINT_TYPES = ["embeddings", "image-generation", "openai-video", "jina-rerank"] as const;

/** Requested modality for a catalog read. `text` is the always-present baseline. */
export type OrcaRouterModality = "image" | "audio" | "video";

/**
 * Catalog selectors. `chat` matches the documented `?capability=chat` value used
 * by the workspace-scoped list; `text` is the local first-class chat filter.
 */
export type OrcaRouterCapability = "text" | "chat" | "image-input" | "embedding" | "image" | "video" | "rerank";

/** Bounds so a catalog response cannot consume unbounded memory. */
export const ORCAROUTER_CATALOG_TIMEOUT_MS = 15_000;
export const ORCAROUTER_CATALOG_MAX_BYTES = 4 * 1024 * 1024;
export const ORCAROUTER_CATALOG_MAX_ITEMS = 5_000;

export interface OrcaRouterModelRecord {
	id: string;
	name?: string;
	contextLength?: number;
	maxCompletionTokens?: number;
	inputModalities?: readonly string[];
	outputModalities?: readonly string[];
	endpointTypes: readonly string[];
	/** USD per million tokens. */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** Whether the catalog advertises any structured reasoning surface. */
	reasoning: boolean;
}

export type OrcaRouterCatalog = readonly OrcaRouterModelRecord[];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
	const parsed = typeof value === "string" ? Number(value) : value;
	return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Parse a per-token USD price string such as "0.0000006600" into USD/million. */
function readPerMillion(value: unknown): number {
	const perToken = readPositiveNumber(value);
	return perToken === undefined ? 0 : perToken * 1_000_000;
}

function readModalities(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const modalities = value.filter((entry): entry is string => typeof entry === "string");
	return modalities.length > 0 ? modalities : undefined;
}

function readEndpointTypes(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Whether a catalog entry advertises a structured reasoning surface. The list
 * endpoint does not carry an explicit reasoning flag for every route, so a
 * present `pricing.reasoning` (or the legacy `top_provider.is_moderated`-style
 * absence) is not treated as proof; only an explicit declaration counts.
 */
function readReasoning(entry: Record<string, unknown>): boolean {
	const architecture = isRecord(entry.architecture) ? entry.architecture : undefined;
	if (architecture && typeof architecture.reasoning === "boolean") return architecture.reasoning;
	const topProvider = isRecord(entry.top_provider) ? entry.top_provider : undefined;
	if (topProvider && typeof topProvider.reasoning === "boolean") return topProvider.reasoning;
	return false;
}

/** Parse one catalog entry. Returns undefined for entries pi cannot represent. */
export function parseOrcaRouterModel(entry: unknown): OrcaRouterModelRecord | undefined {
	if (!isRecord(entry)) return undefined;
	const id = readString(entry.id);
	if (!id) return undefined;

	const architecture = isRecord(entry.architecture) ? entry.architecture : undefined;
	const topProvider = isRecord(entry.top_provider) ? entry.top_provider : undefined;
	const pricing = isRecord(entry.pricing) ? entry.pricing : undefined;

	const contextLength =
		readPositiveNumber(entry.context_length) ??
		(topProvider ? readPositiveNumber(topProvider.context_length) : undefined);
	const maxCompletionTokens =
		readPositiveNumber(entry.max_completion_tokens) ??
		(topProvider ? readPositiveNumber(topProvider.max_completion_tokens) : undefined);

	return {
		id,
		name: readString(entry.name),
		contextLength,
		maxCompletionTokens,
		inputModalities: architecture ? readModalities(architecture.input_modalities) : undefined,
		outputModalities: architecture ? readModalities(architecture.output_modalities) : undefined,
		endpointTypes: readEndpointTypes(entry.supported_endpoint_types),
		cost: {
			input: pricing ? readPerMillion(pricing.prompt_per_million ?? pricing.prompt) : 0,
			output: pricing ? readPerMillion(pricing.completion_per_million ?? pricing.completion) : 0,
			cacheRead: pricing ? readPerMillion(pricing.input_cache_read) : 0,
			cacheWrite: pricing ? readPerMillion(pricing.input_cache_write) : 0,
		},
		reasoning: readReasoning(entry),
	};
}

/**
 * Parse a whole `GET /v1/models` body. Accepts either the OpenAI-shaped
 * `{ data: [...] }` envelope or a bare array. Item count is capped.
 */
export function parseOrcaRouterCatalog(body: unknown): OrcaRouterCatalog {
	const list = isRecord(body) ? body.data : body;
	if (!Array.isArray(list)) return [];
	const parsed: OrcaRouterModelRecord[] = [];
	for (const entry of list.slice(0, ORCAROUTER_CATALOG_MAX_ITEMS)) {
		const model = parseOrcaRouterModel(entry);
		if (model) parsed.push(model);
	}
	return parsed;
}

/** The `capability` query value sent to the catalog endpoint, if any. */
export function capabilityQueryValue(capability: OrcaRouterCapability): string | undefined {
	switch (capability) {
		case "embedding":
			return "embedding";
		case "image":
			return "image";
		case "video":
			return "video";
		case "rerank":
			return "rerank";
		// Text, chat, and image-input all read the same chat-scoped workspace list
		// and are separated locally by endpoint type and declared modalities.
		default:
			return "chat";
	}
}

function hasTextEndpointType(model: OrcaRouterModelRecord): boolean {
	if (model.endpointTypes.length === 0) return false;
	if (model.endpointTypes.some((type) => (NON_TEXT_ENDPOINT_TYPES as readonly string[]).includes(type))) {
		// A route that advertises only non-text types is not a chat route.
		return model.endpointTypes.some((type) => (ORCAROUTER_TEXT_ENDPOINT_TYPES as readonly string[]).includes(type));
	}
	return model.endpointTypes.some((type) => (ORCAROUTER_TEXT_ENDPOINT_TYPES as readonly string[]).includes(type));
}

function hasOnlyEndpointType(model: OrcaRouterModelRecord, endpointType: string): boolean {
	return model.endpointTypes.length > 0 && model.endpointTypes.every((type) => type === endpointType);
}

/**
 * A text chat model: speaks at least one first-class text endpoint type and is
 * not a media/embedding/rerank-only route.
 */
export function isTextChatModel(model: OrcaRouterModelRecord): boolean {
	if (hasOnlyEndpointType(model, "embeddings")) return false;
	if (hasOnlyEndpointType(model, "image-generation")) return false;
	if (hasOnlyEndpointType(model, "openai-video")) return false;
	if (hasOnlyEndpointType(model, "jina-rerank")) return false;
	return hasTextEndpointType(model);
}

/**
 * A chat model that explicitly declares the requested non-text input modality.
 * Undeclared modalities fail closed: an entry with no `architecture` block can
 * never be selected for image/audio/video input.
 */
export function isMultimodalChatModel(model: OrcaRouterModelRecord, modality: OrcaRouterModality): boolean {
	if (!isTextChatModel(model)) return false;
	return model.inputModalities?.includes(modality) === true;
}

export function isEmbeddingModel(model: OrcaRouterModelRecord): boolean {
	return model.endpointTypes.includes("embeddings");
}

export function isImageGenerationModel(model: OrcaRouterModelRecord): boolean {
	return model.endpointTypes.includes("image-generation");
}

export function isVideoModel(model: OrcaRouterModelRecord): boolean {
	return model.endpointTypes.includes("openai-video");
}

export function isRerankModel(model: OrcaRouterModelRecord): boolean {
	return model.endpointTypes.includes("jina-rerank");
}

/**
 * Filter a catalog for one capability. `modality` narrows chat reads to models
 * that explicitly declare that input modality.
 */
export function filterOrcaRouterCatalog(
	catalog: OrcaRouterCatalog,
	capability: OrcaRouterCapability,
	modality?: OrcaRouterModality,
): OrcaRouterCatalog {
	switch (capability) {
		case "text":
		case "chat":
			return modality
				? catalog.filter((model) => isMultimodalChatModel(model, modality))
				: catalog.filter(isTextChatModel);
		case "image-input":
			return catalog.filter((model) => isMultimodalChatModel(model, modality ?? "image"));
		case "embedding":
			return catalog.filter(isEmbeddingModel);
		case "image":
			return catalog.filter(isImageGenerationModel);
		case "video":
			return catalog.filter(isVideoModel);
		case "rerank":
			return catalog.filter(isRerankModel);
	}
}
