// The pi.dev model catalog of a built-in provider type, as pure steps: the request (`catalogRequest`: the provider's
// chat models, revalidated by the stored ETag, as the bundled pi-ai's version), what an answer stores
// (`catalogAnswer`), when the next request is due (`catalogDue`), and the overlay (`overlay`: the shipped models with
// a newer catalog's laid over by id). Cut from coding-agent's
// `packages/coding-agent/src/core/remote-catalog-provider.ts` (Mario, 2026-11-26: a copy, not a move into pi-ai) to
// what p3 uses: chat models only (pi.dev answers a map by id to a request without `?types`), nothing kept in memory,
// no personalized catalog. The loop that runs them is the type's (`builtin-catalogs.ts`).

import type { Api, Model } from "@earendil-works/p3/v1";
import type { CatalogEntry } from "./contract.server.ts";

/** Where a type requests its catalog and as whom: pi.dev picks the catalog by the client version the agent names. */
export type CatalogNetwork = { readonly baseUrl: string; readonly userAgent: string };

/** One catalog request: its address and headers. */
export type CatalogRequest = { readonly url: URL; readonly headers: Readonly<Record<string, string>> };

/**
 * The request for provider `provider`'s catalog: its chat models at `network`, revalidated by `stored`'s ETag when a
 * stored body backs it (a 304 then keeps that body).
 */
export function catalogRequest(
	provider: string,
	stored: CatalogEntry | undefined,
	network: CatalogNetwork,
): CatalogRequest {
	const url = new URL(`/api/models/providers/${encodeURIComponent(provider)}`, network.baseUrl);
	const revalidate = stored?.etag !== undefined && stored.models.length > 0;
	const headers = {
		accept: "application/json",
		"user-agent": network.userAgent,
		...(revalidate ? { "if-none-match": stored.etag! } : {}),
	};
	return { url, headers };
}

/** What pi.dev answered: its status, the two headers that matter, and its body (read only for a 200). */
export type CatalogResponse = {
	readonly status: number;
	readonly lastModified: string | null;
	readonly etag: string | null;
	readonly body?: unknown;
};

/**
 * What an answer means, by `kind`, with the entry to store: `fresh` (a new catalog), `unchanged` (304: the stored
 * body, checked now), `missing` (404 or 501: pi.dev keeps no catalog of the provider; no models), or `failed`
 * (anything else: nothing stored, the stored entry stays).
 */
export type CatalogAnswer =
	| { readonly kind: "fresh" | "unchanged" | "missing"; readonly entry: CatalogEntry }
	| { readonly kind: "failed"; readonly status: number };

/** What `response` to a request of provider `provider`'s catalog over `stored` stores, at `now`. */
export function catalogAnswer(
	provider: string,
	stored: CatalogEntry | undefined,
	response: CatalogResponse,
	now: number,
): CatalogAnswer {
	const { status } = response;
	if (status === 304 && stored !== undefined) return { kind: "unchanged", entry: { ...stored, checkedAt: now } };
	if (status === 404 || status === 501)
		return { kind: "missing", entry: { models: [], lastModified: 0, checkedAt: now } };
	if (status !== 200) return { kind: "failed", status };
	const lastModified = Date.parse(response.lastModified ?? "");
	return {
		kind: "fresh",
		entry: {
			models: parse(provider, response.body),
			lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
			...(response.etag === null ? {} : { etag: response.etag }),
			checkedAt: now,
		},
	};
}

/** How long a catalog pi.dev answered is not requested again. */
export const CHECK_EVERY_MS = 4 * 60 * 60_000;

/** How long after a failed request the next one goes out. */
export const RETRY_AFTER_MS = 15 * 60_000;

/**
 * When provider `stored`'s next request is due: at once without an entry, four hours after pi.dev last answered, or
 * a quarter of an hour after a failure (`failedAt`).
 */
export function catalogDue(stored: CatalogEntry | undefined, failedAt: number | undefined): number {
	if (failedAt !== undefined) return failedAt + RETRY_AFTER_MS;
	return stored === undefined ? 0 : stored.checkedAt + CHECK_EVERY_MS;
}

/**
 * The shipped chat models `shipped` with the ones of `entry` laid over by id, when the entry's catalog is newer than
 * the shipped model data (`shippedAt`; unknown: any catalog is); `shipped` itself otherwise.
 */
export function overlay(
	shipped: readonly Model<Api>[],
	entry: CatalogEntry | undefined,
	shippedAt: number | undefined,
): readonly Model<Api>[] {
	if (entry === undefined || entry.models.length === 0) return shipped;
	if (shippedAt !== undefined && entry.lastModified <= shippedAt) return shipped;
	// Only `catalogAnswer` stores models, each one of pi-ai's chat definitions as pi.dev serves them.
	const newer = entry.models as readonly Model<Api>[];
	const byId = new Map(shipped.map((model) => [model.id, model]));
	for (const model of newer) byId.set(model.id, model);
	return [...byId.values()];
}

/**
 * A catalog's models: pi.dev's answer, wire input checked here (a map of chat models by id); every entry an object
 * with a text `id`, under the provider's id.
 */
function parse(provider: string, body: unknown): Record<string, unknown>[] {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
	return Object.values(body)
		.filter((model): model is Record<string, unknown> => typeof model === "object" && model !== null)
		.filter((model) => typeof model.id === "string")
		.map((model) => ({ ...model, provider }));
}
