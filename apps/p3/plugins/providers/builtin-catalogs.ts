// The catalogs of pi-ai's built-in provider types (`LoginCatalogs`): each keeps its provider's pi.dev catalog current
// on its own, requesting it whenever its stored timing says (`catalogWait`: four hours after pi.dev last answered, a
// quarter of an hour after a failure, kept across a reload and a restart) and storing what the answer means
// (`catalogAnswer`). pi.dev's address is the server's (`ServerRuntime.catalogBaseUrl`); without one the types request
// nothing and their logins keep the shipped models. A failure of any kind (the network, the answer, the store) is a
// failed request, retried later; an outage is reported once, at its first failure.

import {
	BACKGROUND_CONTEXT,
	contribute,
	type FacetHost,
	type P3Principal,
	type Provider,
	reportError,
	sleep,
	withAbortSignal,
} from "@earendil-works/p3/v1";
import { formatUserAgent, ServerRuntime } from "@earendil-works/p3/v1/server";
import {
	type CatalogNetwork,
	type CatalogRequest,
	type CatalogResponse,
	catalogAnswer,
	catalogRequest,
	catalogWait,
	MAX_BODY_BYTES,
	RETRY_AFTER_MS,
} from "./catalog.ts";
import { type CatalogContext, type LoginCatalog, LoginCatalogs } from "./login-catalogs.ts";

/** Contributes the catalogs of `providers` (pi-ai's built-in ones) to `LoginCatalogs`, at the server's pi.dev. */
export function serveBuiltinCatalogs(host: FacetHost<P3Principal>, providers: readonly Provider[]): void {
	contribute(host, "providers.builtin-catalogs", (self) => {
		const { catalogBaseUrl } = self.registry(ServerRuntime).value;
		// The bundled pi-ai's version: pi.dev serves the newest catalog published for it.
		const network =
			catalogBaseUrl === undefined ? undefined : { baseUrl: catalogBaseUrl, userAgent: formatUserAgent() };
		self.contribute(LoginCatalogs, builtinCatalogs(providers, network));
	});
}

/** Providers pi.dev keeps no catalog of (Radius serves its own). */
const UNLISTED: ReadonlySet<string> = new Set(["radius"]);

/** The catalogs of `providers` that pi.dev keeps, requested at `network` (none: they request nothing). */
export function builtinCatalogs(providers: readonly Provider[], network: CatalogNetwork | undefined): LoginCatalog[] {
	return providers
		.filter(({ id }) => !UNLISTED.has(id))
		.map(({ id }) => ({ provider: id, run: (context) => keepCurrent(id, network, context) }));
}

/** Keeps provider `provider`'s stored catalog current until `signal` ends: one request whenever it is due. */
async function keepCurrent(
	provider: string,
	network: CatalogNetwork | undefined,
	{ store, signal }: CatalogContext,
): Promise<void> {
	if (network === undefined) return;
	const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
	let outage = false;
	while (!signal.aborted) {
		// Only the timing while it waits: no body is kept for four hours.
		const wait = await store.status().then(
			(status) => catalogWait(status, Date.now()),
			// The store failed: as after a failed request.
			() => RETRY_AFTER_MS,
		);
		if (
			!(await sleep(wait, context).then(
				() => true,
				() => false,
			))
		)
			return;
		const answered = await requested(provider, network, store, signal).catch(() => false);
		if (signal.aborted) return;
		if (!answered) {
			await store.failed(Date.now()).catch(() => undefined);
			// Nothing of the failure: a response's text is pi.dev's, or anything a network says.
			if (!outage) reportError(`providers: ${provider}: its catalog request failed`, "a failure", context);
		}
		outage = !answered;
	}
}

/** How long one request may take, its body read included. */
const REQUEST_MS = 10_000;

/**
 * Requests provider `provider`'s catalog over its stored one and stores what the answer means; whether it was
 * answered (a body or unchanged), not a failure.
 */
async function requested(
	provider: string,
	network: CatalogNetwork,
	store: CatalogContext["store"],
	signal: AbortSignal,
): Promise<boolean> {
	const request = catalogRequest(provider, await store.read(), network);
	const answer = catalogAnswer(provider, request, await fetched(request, signal));
	switch (answer.kind) {
		case "body":
			await store.write(answer.entry, Date.now());
			return true;
		case "unchanged":
			await store.checked(Date.now());
			return true;
		case "failed":
			return false;
	}
}

/** pi.dev's answer to `request`, a 200's body read, at most `MAX_BODY_BYTES` of it, all within `REQUEST_MS`. */
async function fetched(request: CatalogRequest, signal: AbortSignal): Promise<CatalogResponse> {
	const timeout = new AbortController();
	// A timer of its own (not `AbortSignal.timeout`): the request and its body share one bound.
	const timer = setTimeout(() => timeout.abort(), REQUEST_MS);
	try {
		const response = await fetch(request.url, {
			headers: request.headers,
			signal: AbortSignal.any([signal, timeout.signal]),
		});
		const answer = {
			status: response.status,
			lastModified: response.headers.get("last-modified"),
			etag: response.headers.get("etag"),
		};
		if (response.status !== 200) {
			await response.body?.cancel();
			return answer;
		}
		// A body too large is no text: a failure.
		const text = await bounded(response);
		return text === undefined ? answer : { ...answer, text };
	} finally {
		clearTimeout(timer);
	}
}

/** `response`'s body as text, or `undefined` once it holds more than `MAX_BODY_BYTES` (the rest is not read). */
async function bounded(response: Response): Promise<string | undefined> {
	const declared = Number(response.headers.get("content-length") ?? 0);
	if (declared > MAX_BODY_BYTES || response.body === null) {
		await response.body?.cancel();
		return response.body === null ? "" : undefined;
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	// Leaving the loop early cancels the rest of the body.
	for await (const chunk of response.body) {
		size += chunk.byteLength;
		if (size > MAX_BODY_BYTES) return undefined;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}
