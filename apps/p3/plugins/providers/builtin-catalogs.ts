// The catalogs of pi-ai's built-in provider types (`LoginCatalogs`): each keeps its provider's pi.dev catalog current
// on its own, requesting it whenever its stored entry is due (`catalogDue`: four hours after pi.dev last answered, a
// quarter of an hour after a failure) and storing what the answer means (`catalogAnswer`). Without network it
// requests nothing; its logins keep the shipped models.

import { BACKGROUND_CONTEXT, type Provider, reportError, sleep, withAbortSignal } from "@earendil-works/p3/v1";
import { type CatalogNetwork, catalogAnswer, catalogDue, catalogRequest } from "./catalog.ts";
import type { CatalogEntry } from "./contract.server.ts";
import type { CatalogContext, LoginCatalog } from "./login-catalogs.ts";

/** Providers pi.dev keeps no catalog of (Radius serves its own). */
const UNLISTED: ReadonlySet<string> = new Set(["radius"]);

/** The catalogs of `providers` (pi-ai's built-in ones) that pi.dev keeps. */
export function builtinCatalogs(providers: readonly Provider[]): LoginCatalog[] {
	return providers
		.filter(({ id }) => !UNLISTED.has(id))
		.map(({ id }) => ({ provider: id, catalog: (context) => keepCurrent(id, context) }));
}

/** How long one request may take. */
const REQUEST_MS = 10_000;

/** Keeps provider `provider`'s stored catalog current until `signal` ends: one request whenever its entry is due. */
async function keepCurrent(provider: string, { store, network, signal }: CatalogContext): Promise<void> {
	if (network === undefined) return;
	const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
	let failedAt: number | undefined;
	while (!signal.aborted) {
		const stored = await store.read();
		await sleep(Math.max(catalogDue(stored, failedAt) - Date.now(), 0), context).catch(() => undefined);
		if (signal.aborted) return;
		const answered = await requested(provider, stored, network, signal);
		if (answered === "failed") {
			failedAt = Date.now();
			// Nothing of the failure: a response's text is pi.dev's, or anything a network says.
			reportError(`providers: ${provider}: its catalog request failed`, "a failure", context);
			continue;
		}
		failedAt = undefined;
		await store.write(answered);
	}
}

/** The entry pi.dev's answer for `provider` over `stored` stores, or `failed` (the request too). */
async function requested(
	provider: string,
	stored: CatalogEntry | undefined,
	network: CatalogNetwork,
	signal: AbortSignal,
): Promise<CatalogEntry | "failed"> {
	const { url, headers } = catalogRequest(provider, stored, network);
	try {
		const response = await fetch(url, {
			headers,
			signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]),
		});
		const body = response.status === 200 ? await response.json() : undefined;
		const answer = catalogAnswer(
			provider,
			stored,
			{
				status: response.status,
				lastModified: response.headers.get("last-modified"),
				etag: response.headers.get("etag"),
				body,
			},
			Date.now(),
		);
		return answer.kind === "failed" ? "failed" : answer.entry;
	} catch {
		return "failed";
	}
}
