import {
	type AnyModel,
	getModelType,
	isModelType,
	type ModelsStoreEntry,
	type ModelType,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { VERSION } from "../config.ts";
import { fetchWithRetry } from "../utils/management-http.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";

const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
const REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS = 4_000;
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
/**
 * Model types this client can consume. Sent as `?types=` so the catalog server
 * returns the full-type shard instead of the chat-only one served to clients
 * that predate model types. A server that ignores the parameter still returns
 * the chat-only shard, which this client handles unchanged.
 */
export const REMOTE_CATALOG_MODEL_TYPES: readonly ModelType[] = ["chat", "image", "classifier"];

function isSupportedModelType(model: { type?: unknown }): boolean {
	return (
		model.type === undefined ||
		(typeof model.type === "string" && REMOTE_CATALOG_MODEL_TYPES.includes(model.type as ModelType))
	);
}

function mergeModels<TModel extends AnyModel>(baseline: readonly TModel[], dynamic: readonly TModel[]): TModel[] {
	const merged = new Map<string, TModel>();
	for (const model of [...baseline, ...dynamic]) merged.set(`${getModelType(model)}\0${model.id}`, model);
	return [...merged.values()];
}

function parseCatalog(providerId: string, value: unknown): AnyModel[] {
	const entries = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && "models" in value && Array.isArray(value.models)
			? value.models
			: typeof value === "object" && value !== null
				? Object.values(value)
				: undefined;
	if (!entries) throw new Error(`Invalid model catalog for provider "${providerId}"`);
	return entries
		.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && "id" in entry)
		.filter(isSupportedModelType)
		.map((model) => ({ ...model, provider: providerId }) as AnyModel);
}

/** Read a successful pi.dev catalog response. A missing or invalid Last-Modified header is 0. */
async function readCatalog(
	providerId: string,
	response: Response,
): Promise<{ models: AnyModel[]; lastModified: number; etag: string | undefined }> {
	const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
	return {
		models: parseCatalog(providerId, await response.json()),
		lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
		etag: response.headers.get("etag") ?? undefined,
	};
}

/** Whether a pi.dev catalog is newer than the model data shipped with pi. */
function isNewer(lastModified: number | undefined, localGeneratedAt: number | undefined): boolean {
	return localGeneratedAt === undefined || (lastModified !== undefined && lastModified > localGeneratedAt);
}

function remoteModels(entry: ModelsStoreEntry | undefined, localGeneratedAt: number | undefined): readonly AnyModel[] {
	return entry && isNewer(entry.lastModified, localGeneratedAt) ? entry.models : [];
}

function requestCatalog(
	providerId: string,
	catalogBaseUrl: string,
	signal: AbortSignal,
	validator?: string,
): Promise<Response> {
	const url = new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, catalogBaseUrl);
	url.searchParams.set("types", REMOTE_CATALOG_MODEL_TYPES.join(","));
	return fetchWithRetry(
		url,
		{
			headers: {
				accept: "application/json",
				"User-Agent": getPiUserAgent(VERSION),
				...(validator ? { "if-none-match": validator } : {}),
			},
			signal,
		},
		{ attemptTimeoutMs: REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS },
	);
}

/** Replaces the catalog with a credential-specific model list. */
export type PersonalizeCatalog = (
	catalog: readonly AnyModel[],
	context: RefreshModelsContext,
) => Promise<readonly AnyModel[]>;

/** Add a persisted pi.dev catalog overlay to a static built-in provider. */
export function withRemoteCatalog(
	provider: Provider,
	catalogBaseUrl: string = DEFAULT_CATALOG_BASE_URL,
	localGeneratedAt?: number,
): Provider {
	let dynamicModels: readonly AnyModel[] = [];

	return {
		...provider,
		getModels: () =>
			mergeModels(
				provider.getModels(),
				dynamicModels.filter((model) => isModelType(model, "chat")),
			),
		getAllModels: () => mergeModels(provider.getAllModels?.() ?? provider.getModels(), dynamicModels),
		refreshModels: async (context) => {
			const stored = context.stored;
			const restored = remoteModels(stored, localGeneratedAt).filter((model) => model.provider === provider.id);
			if (
				!(await context.publish({
					update: () => {
						dynamicModels = restored;
					},
				}))
			) {
				return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			// Skip the request if pi.dev was checked less than REMOTE_CATALOG_REFRESH_INTERVAL_MS ago.
			// An entry without lastModified (saved by an older pi, or after a failed first request) is
			// always refetched: remoteModels() ignores it, so waiting would leave the overlay empty.
			if (
				!context.force &&
				stored?.checkedAt !== undefined &&
				stored.lastModified !== undefined &&
				Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS
			) {
				return;
			}

			// Only revalidate when a cached body backs the validator, so a 304 can never
			// leave the overlay empty.
			const validator = stored && stored.models.length > 0 ? stored.etag : undefined;
			const response = await requestCatalog(provider.id, catalogBaseUrl, context.signal, validator);
			if (context.signal.aborted) return;
			const checkedAt = Date.now();
			// Unchanged: dynamicModels already holds the stored overlay, so only the
			// freshness window moves.
			if (response.status === 304 && stored) {
				await context.publish({ persist: { ...stored, checkedAt } });
				return;
			}
			if (response.status === 404 || response.status === 501) {
				await context.publish({
					persist: {
						...(stored ?? { models: [] }),
						checkedAt,
						lastModified: 0,
						etag: undefined,
					},
				});
				return;
			}
			if (!response.ok) {
				// Transient failure: the cached body and its validator stay valid, so keep the
				// etag and let the next refresh revalidate instead of downloading the catalog.
				await context.publish({ persist: { ...(stored ?? { models: [] }), checkedAt } });
				throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
			}
			const catalog = await readCatalog(provider.id, response);
			if (context.signal.aborted) return;
			const entry: ModelsStoreEntry = { ...catalog, checkedAt };
			const published = remoteModels(entry, localGeneratedAt);
			await context.publish({
				persist: entry,
				update: () => {
					dynamicModels = published;
				},
			});
		},
	};
}

/**
 * Like `withRemoteCatalog`, but on each network refresh the catalog (built-in models plus a newer
 * pi.dev catalog) is passed through `personalize` and the result is saved. The saved entry holds
 * the personalized list, not the pi.dev catalog, and replaces the catalog, including offline.
 * The refresh interval and etag revalidation are skipped. An empty list (nothing saved yet, or an
 * empty catalog saved by an older pi after a failed or missing pi.dev catalog) falls back to the
 * built-in models.
 */
export function withPersonalizedCatalog(
	provider: Provider,
	personalize: PersonalizeCatalog,
	catalogBaseUrl: string = DEFAULT_CATALOG_BASE_URL,
	localGeneratedAt?: number,
): Provider {
	let personalModels: readonly AnyModel[] = [];
	const builtinModels = (): readonly AnyModel[] => provider.getAllModels?.() ?? provider.getModels();
	const getAllModels = (): readonly AnyModel[] => (personalModels.length > 0 ? personalModels : builtinModels());

	return {
		...provider,
		getModels: () => getAllModels().filter((model) => isModelType(model, "chat")),
		getAllModels,
		refreshModels: async (context) => {
			const restored = (context.stored?.models ?? []).filter((model) => model.provider === provider.id);
			if (
				!(await context.publish({
					update: () => {
						personalModels = restored;
					},
				}))
			) {
				return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;

			const response = await requestCatalog(provider.id, catalogBaseUrl, context.signal);
			if (context.signal.aborted) return;
			let remote: readonly AnyModel[] = [];
			if (response.status !== 404 && response.status !== 501) {
				if (!response.ok) throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
				const catalog = await readCatalog(provider.id, response);
				if (isNewer(catalog.lastModified, localGeneratedAt)) remote = catalog.models;
			}
			const personalized = await personalize(mergeModels(builtinModels(), remote), context);
			if (context.signal.aborted) return;
			await context.publish({
				persist: { models: personalized, checkedAt: Date.now() },
				update: () => {
					personalModels = personalized;
				},
			});
		},
	};
}
