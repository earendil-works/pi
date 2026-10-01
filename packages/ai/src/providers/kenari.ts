import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";

export const KENARI_BASE_URL = "https://kenari.id/v1";
export const KENARI_MODELS_URL = `${KENARI_BASE_URL}/models`;

/** Stand-in output cap. The public list has no max output. */
const KENARI_OUTPUT_CAP = 8192;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/**
 * One offline model so the built-in provider is usable before the live list
 * arrives. The coding-agent test requires every built-in to have a model, and
 * the generator only reads models.dev, which does not list Kenari.
 */
const KENARI_SEED: Model<"openai-completions"> = {
	id: "claude-sonnet-5-5",
	name: "claude-sonnet-5-5",
	api: "openai-completions",
	provider: "kenari",
	baseUrl: KENARI_BASE_URL,
	reasoning: true,
	input: ["text", "image"],
	cost: { ...ZERO_COST },
	contextWindow: 1_000_000,
	maxTokens: KENARI_OUTPUT_CAP,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function kenariInput(entry: Record<string, unknown>): ("text" | "image")[] {
	const modalities = entry.modalities;
	const raw = isRecord(modalities) && Array.isArray(modalities.input) ? modalities.input : [];
	const input: ("text" | "image")[] = [];
	for (const item of raw) {
		if ((item === "text" || item === "image") && !input.includes(item)) input.push(item);
	}
	if (!input.includes("text")) input.unshift("text");
	return input;
}

function kenariModel(entry: unknown): Model<"openai-completions"> | undefined {
	if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) return undefined;
	if (entry.id === "kenari/auto" || entry.tool_call !== true) return undefined;
	const contextWindow = positiveNumber(entry.context_length);
	if (contextWindow === undefined) return undefined;
	const name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id;
	return {
		id: entry.id,
		name,
		api: "openai-completions",
		provider: "kenari",
		baseUrl: KENARI_BASE_URL,
		reasoning: entry.reasoning === true,
		input: kenariInput(entry),
		// pricing.* is micro-rupiah per 1M tokens. cost is USD per 1M. Leave it at 0.
		cost: { ...ZERO_COST },
		contextWindow,
		maxTokens: Math.min(KENARI_OUTPUT_CAP, contextWindow),
	};
}

/** Map a `GET /v1/models` body. Throws when the body is not a model list. */
export function kenariModelsFromPayload(payload: unknown): Model<"openai-completions">[] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new Error("Kenari model list has no data array");
	}
	const models: Model<"openai-completions">[] = [];
	const seen = new Set<string>();
	for (const entry of payload.data) {
		const model = kenariModel(entry);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	models.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
	return models;
}

export async function fetchKenariModels(
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<Model<"openai-completions">[]> {
	const response = await fetchImpl(KENARI_MODELS_URL, {
		headers: { accept: "application/json" },
		signal,
	});
	if (!response.ok) throw new Error(`Kenari model list failed: ${response.status}`);
	return kenariModelsFromPayload(await response.json());
}

export function kenariProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "kenari",
		name: "Kenari",
		baseUrl: KENARI_BASE_URL,
		auth: { apiKey: envApiKeyAuth("Kenari API key", ["KENARI_API_KEY"]) },
		models: [KENARI_SEED],
		fetchModels: (context) => fetchKenariModels(context.signal),
		api: openAICompletionsApi(),
	});
}
