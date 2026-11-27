// The pi.dev model catalog of a built-in provider type, as pure steps: the request (`catalogRequest`: the provider's
// chat models, revalidated by the stored ETag, as the bundled pi-ai's version), what an answer means (`catalogAnswer`:
// a body checked and bounded, unchanged, or a failure), how long until the next request (`catalogWait`), and the
// overlay (`overlay`: the shipped models with a newer catalog's laid over by id). Cut from coding-agent's
// `packages/coding-agent/src/core/remote-catalog-provider.ts` (Mario, 2026-11-26: a copy, not a move into pi-ai) to
// what p3 uses: chat models only (pi.dev answers a map by id to a request without `?types`), nothing kept in memory,
// no personalized catalog (OpenRouter's narrowing to a key's own models, prices and limits is not built). The catalog
// server is trusted with model metadata only: a model's endpoint (`baseUrl`), `headers` and dispatch `api` stay the
// shipped provider's, whatever the catalog says, so it can never choose where a login's key is sent. One request per
// type, as decided; pi.dev also serves the whole chat catalog in one answer (`/api/models`), an alternative with one
// ETag for all. The loop that runs them is the type's (`builtin-catalogs.ts`).

import type { Api, Model, Provider } from "@earendil-works/p3/v1";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/p3/v1/server";
import type { CatalogEntry, CatalogStatus } from "./contract.server.ts";

/** Where a type requests its catalog and as whom: pi.dev picks the catalog by the client version the agent names. */
export type CatalogNetwork = { readonly baseUrl: string; readonly userAgent: string };

/** One catalog request: its address and headers, and whether it revalidates a stored body (a 304 keeps it then). */
export type CatalogRequest = {
	readonly url: URL;
	readonly headers: Readonly<Record<string, string>>;
	readonly conditional: boolean;
};

/**
 * The request for provider `provider`'s catalog: its chat models at `network`, revalidated by `stored`'s ETag when a
 * stored body backs it. Throws for an address that is no URL (the loop counts it a failed request).
 */
export function catalogRequest(
	provider: string,
	stored: CatalogEntry | undefined,
	network: CatalogNetwork,
): CatalogRequest {
	const url = new URL(`/api/models/providers/${encodeURIComponent(provider)}`, network.baseUrl);
	const conditional = stored?.etag !== undefined && stored.models.length > 0;
	const headers = {
		accept: "application/json",
		"user-agent": network.userAgent,
		...(conditional ? { "if-none-match": stored.etag! } : {}),
	};
	return { url, headers, conditional };
}

/** What pi.dev answered: its status, the two headers that matter, and its body's text (read only for a 200). */
export type CatalogResponse = {
	readonly status: number;
	readonly lastModified: string | null;
	readonly etag: string | null;
	readonly text?: string;
};

/**
 * What an answer means, by `kind`: a new `body` to store (a 200's catalog, or no models for a provider pi.dev keeps no
 * catalog of: 404, 501), `unchanged` (a 304 to a conditional request), or `failed` (anything else, a 304 nothing
 * asked for, and a body too large, not JSON or not a map of models; the stored entry stays).
 */
export type CatalogAnswer =
	| { readonly kind: "body"; readonly entry: CatalogEntry }
	| { readonly kind: "unchanged" }
	| { readonly kind: "failed" };

/** The most a catalog's body may hold: bytes of text, and models (pi.dev's largest, OpenRouter's, is about 244 KB). */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_MODELS = 5_000;

/** What `response` to `request` for provider `provider`'s catalog means. */
export function catalogAnswer(provider: string, request: CatalogRequest, response: CatalogResponse): CatalogAnswer {
	const { status } = response;
	if (status === 304) return request.conditional ? { kind: "unchanged" } : { kind: "failed" };
	if (status === 404 || status === 501) return { kind: "body", entry: { models: [], lastModified: 0 } };
	if (status !== 200 || response.text === undefined) return { kind: "failed" };
	if (Buffer.byteLength(response.text) > MAX_BODY_BYTES) return { kind: "failed" };
	const models = parse(provider, response.text);
	if (models === undefined) return { kind: "failed" };
	const lastModified = Date.parse(response.lastModified ?? "");
	return {
		kind: "body",
		entry: {
			models,
			lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
			...(response.etag === null ? {} : { etag: response.etag }),
		},
	};
}

/** How long a catalog pi.dev answered is not requested again. */
export const CHECK_EVERY_MS = 4 * 60 * 60_000;

/** How long after a failed request the next one goes out. */
export const RETRY_AFTER_MS = 15 * 60_000;

/**
 * How long from `now` until provider's next request, by its `status`: none stored, at once; a failure since it was
 * last answered, a quarter of an hour after it; else four hours after the answer. Never longer than that interval,
 * whatever the clock did (set back, it would wait the longer way round).
 */
export function catalogWait(status: CatalogStatus | null, now: number): number {
	if (status === null) return 0;
	const [since, interval] =
		status.failedAt > status.checkedAt ? [status.failedAt, RETRY_AFTER_MS] : [status.checkedAt, CHECK_EVERY_MS];
	return Math.min(Math.max(since + interval - now, 0), interval);
}

/**
 * The fields a catalog may set of a model: its metadata. Everything else (its endpoint, headers, API, routing and
 * retention policy in `compat`, its type) is the shipped provider's (Astra and Opus, rounds 1 and 2 of the catalog).
 */
const METADATA = [
	"name",
	"reasoning",
	"input",
	"inputLimits",
	"cost",
	"contextWindow",
	"maxTokens",
	"thinkingLevelMap",
	"promptCache",
	"samplingParams",
	"samplingParamsByThinkingLevel",
] as const;

/**
 * The shipped chat models `shipped` with the ones of `entry` laid over by id, when the entry's catalog is newer than
 * the shipped model data (`shippedAt`; unknown: any catalog is); `shipped` itself otherwise. A catalog model gives its
 * metadata only (`METADATA`): over the shipped model of its id, or for a new id over the policy (`provider`, `api`,
 * `baseUrl`, `headers`, `compat`) of the first shipped model of its `api`; a new id of an `api` no shipped model has is
 * left out.
 */
export function overlay(
	shipped: readonly Model<Api>[],
	entry: CatalogEntry | undefined,
	shippedAt: number | undefined,
): readonly Model<Api>[] {
	if (entry === undefined || entry.models.length === 0) return shipped;
	if (shippedAt !== undefined && entry.lastModified <= shippedAt) return shipped;
	const byId = new Map(shipped.map((model) => [model.id, model]));
	const byApi = new Map<string, Model<Api>>();
	for (const model of shipped) if (!byApi.has(model.api)) byApi.set(model.api, model);
	// Only `catalogAnswer` stores models, each checked as a chat definition (`isChatModel`).
	for (const model of entry.models as readonly Model<Api>[]) {
		const metadata = Object.fromEntries(
			METADATA.filter((field) => model[field] !== undefined).map((field) => [field, model[field]]),
		);
		const same = byId.get(model.id);
		if (same !== undefined) {
			byId.set(model.id, { ...same, ...metadata });
			continue;
		}
		const base = byApi.get(model.api);
		if (base === undefined) continue;
		const { provider, api, baseUrl, headers, compat } = base;
		const policy = {
			provider,
			api,
			baseUrl,
			...(headers === undefined ? {} : { headers }),
			...(compat === undefined ? {} : { compat }),
		};
		// The required metadata is there: `isChatModel` checked it.
		byId.set(model.id, { id: model.id, ...policy, ...metadata } as Model<Api>);
	}
	return [...byId.values()];
}

/** Provider type `provider`'s chat models: the ones it ships with its stored catalog `entry` laid over (`overlay`). */
export function typeModels(provider: Provider, entry: CatalogEntry | undefined): readonly Model<Api>[] {
	return overlay(provider.getModels(), entry, getBuiltinModelDataGeneratedAt());
}

/**
 * A catalog's models from pi.dev's answer, wire input checked here: JSON, a map of chat models by id, at most
 * `MAX_MODELS`; an entry that is no chat definition is left out, the rest under the provider's id. `undefined` for a
 * body that is not such a map.
 */
function parse(provider: string, text: string): Record<string, unknown>[] | undefined {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
	const entries = Object.values(body);
	if (entries.length > MAX_MODELS) return undefined;
	return entries.filter(isChatModel).map((model) => ({ ...model, provider }));
}

/** Whether `value` has the fields of pi-ai's chat `Model` a request and the picker read, of their types. */
function isChatModel(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const model = value as Record<string, unknown>;
	const cost = model.cost as Record<string, unknown> | undefined;
	return (
		// A chat model: no other type (an image model under a chat model's id would hide it).
		(model.type === undefined || model.type === "chat") &&
		typeof model.id === "string" &&
		model.id !== "" &&
		typeof model.name === "string" &&
		typeof model.api === "string" &&
		typeof model.reasoning === "boolean" &&
		Array.isArray(model.input) &&
		model.input.every((kind) => kind === "text" || kind === "image") &&
		typeof cost === "object" &&
		cost !== null &&
		["input", "output", "cacheRead", "cacheWrite"].every((part) => typeof cost[part] === "number") &&
		isCount(model.contextWindow) &&
		isCount(model.maxTokens)
	);
}

/** Whether `value` is a positive whole number. */
function isCount(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}
