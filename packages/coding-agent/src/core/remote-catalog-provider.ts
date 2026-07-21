import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { VERSION } from "../config.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";

const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

function mergeModels(baseline: readonly Model<Api>[], dynamic: readonly Model<Api>[]): Model<Api>[] {
	const merged = [...baseline];
	for (const model of dynamic) {
		const index = merged.findIndex((entry) => entry.id === model.id);
		if (index >= 0) merged[index] = model;
		else merged.push(model);
	}
	return merged;
}

function parseCatalog(providerId: string, value: unknown): Model<Api>[] {
	const entries = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && "models" in value && Array.isArray(value.models)
			? value.models
			: typeof value === "object" && value !== null
				? Object.values(value)
				: undefined;
	if (!entries) throw new Error(`Invalid model catalog for provider "${providerId}"`);
	return entries
		.filter((entry): entry is Model<Api> => typeof entry === "object" && entry !== null && "id" in entry)
		.map((model) => ({ ...model, provider: providerId }));
}

/** Add a persisted pi.dev catalog overlay to a static built-in provider. */
export function withRemoteCatalog(provider: Provider, catalogBaseUrl: string = DEFAULT_CATALOG_BASE_URL): Provider {
	let dynamicModels: readonly Model<Api>[] = [];
	let inflightRefresh: Promise<void> | undefined;

	return {
		...provider,
		getModels: () => mergeModels(provider.getModels(), dynamicModels),
		refreshModels: (context) => {
			inflightRefresh ??= (async () => {
				try {
					const stored = await context.store.read();
					if (stored) dynamicModels = stored.models.filter((model) => model.provider === provider.id);
					if (!context.allowNetwork || context.signal?.aborted) return;
					if (
						!context.force &&
						stored?.checkedAt !== undefined &&
						Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS
					) {
						return;
					}

					const url = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, catalogBaseUrl);
					const response = await fetch(url, {
						headers: {
							accept: "application/json",
							"User-Agent": getPiUserAgent(VERSION),
						},
						signal: context.signal,
					});
					if (context.signal?.aborted) return;
					const checkedAt = Date.now();
					if (response.status === 404 || response.status === 501) {
						await context.store.write({ models: dynamicModels, checkedAt });
						return;
					}
					if (!response.ok) {
						await context.store.write({ models: dynamicModels, checkedAt });
						throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
					}
					const refreshed = parseCatalog(provider.id, await response.json());
					if (context.signal?.aborted) return;
					dynamicModels = refreshed;
					await context.store.write({ models: refreshed, checkedAt });
				} finally {
					inflightRefresh = undefined;
				}
			})();
			return inflightRefresh;
		},
	};
}
