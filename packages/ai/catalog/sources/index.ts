import {
	DEFAULT_RADIUS_GATEWAY,
	getRadiusModelsFromConfig,
	loadRadiusGatewayConfig,
} from "../../src/providers/radius-config.ts";
import type { Model } from "../../src/types.ts";
import {
	MODELS_DEV_DECISIONS_URL,
	MODELS_DEV_URL,
	type ModelsDevDecisionMetadata,
	type ModelsDevV2Catalog,
} from "./models-dev.ts";
import { fetchOpenRouterCatalog, type OpenRouterCatalog } from "./openrouter.ts";
import { type AiGatewayCatalog, fetchAiGatewayCatalog } from "./vercel-ai-gateway.ts";

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

/** Everything fetched from upstream before the catalog is built. */
export interface CatalogSources {
	modelsDev: ModelsDevV2Catalog;
	modelsDevDecisions: Record<string, ModelsDevDecisionMetadata>;
	openRouter: OpenRouterCatalog;
	aiGateway: AiGatewayCatalog;
	/** Live NVIDIA NIM ids, keyed by both the raw and the normalized id. */
	nvidiaModelIds: Map<string, string>;
	radius: Model<"pi-messages">[];
}

async function fetchJson<T>(url: string, label: string): Promise<T> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${label} returned ${response.status}`);
	return (await response.json()) as T;
}

export function normalizeNvidiaModelId(modelId: string): string {
	return modelId.toLowerCase().replaceAll("_", ".");
}

async function fetchNvidiaModelIds(): Promise<Map<string, string>> {
	const data = await fetchJson<{ data?: { id: string }[] }>(`${NVIDIA_BASE_URL}/models`, "NVIDIA NIM API");
	const modelIds = new Map<string, string>();
	for (const model of data.data ?? []) {
		modelIds.set(model.id, model.id);
		modelIds.set(normalizeNvidiaModelId(model.id), model.id);
	}
	return modelIds;
}

async function fetchRadiusModels(): Promise<Model<"pi-messages">[]> {
	const config = await loadRadiusGatewayConfig(DEFAULT_RADIUS_GATEWAY);
	const models = getRadiusModelsFromConfig("radius", config);
	if (models.length === 0) throw new Error("Radius API returned no models");
	return models;
}

/**
 * Fetch every upstream source. In strict mode any failure aborts generation;
 * otherwise a failed source contributes nothing.
 */
export async function loadCatalogSources(strict: boolean): Promise<CatalogSources> {
	async function load<T>(label: string, fetcher: () => Promise<T>, fallback: T): Promise<T> {
		try {
			console.log(`Fetching ${label}...`);
			return await fetcher();
		} catch (error) {
			console.error(`Failed to fetch ${label}:`, error);
			if (strict) throw error;
			return fallback;
		}
	}

	const modelsDev = await load(
		"models.dev catalog",
		() => fetchJson<ModelsDevV2Catalog>(MODELS_DEV_URL, "models.dev API"),
		{},
	);
	const modelsDevDecisions = await load(
		"models.dev decision models",
		() => fetchJson<Record<string, ModelsDevDecisionMetadata>>(MODELS_DEV_DECISIONS_URL, "models.dev decision API"),
		{},
	);
	const nvidiaModelIds = modelsDev.nvidia?.models
		? await load("NVIDIA NIM models", fetchNvidiaModelIds, new Map<string, string>())
		: new Map<string, string>();
	const openRouter = await load("OpenRouter models", fetchOpenRouterCatalog, {
		chat: [],
		images: [],
		classifiers: [],
	});
	if (strict && openRouter.images.length === 0) throw new Error("OpenRouter API returned no usable image models");
	const aiGateway = await load("Vercel AI Gateway models", fetchAiGatewayCatalog, { chat: [], classifiers: [] });
	const radius = await load("Radius models", fetchRadiusModels, []);

	return { modelsDev, modelsDevDecisions, openRouter, aiGateway, nvidiaModelIds, radius };
}
