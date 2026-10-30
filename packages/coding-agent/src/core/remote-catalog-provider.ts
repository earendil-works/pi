import type { Provider } from "@earendil-works/pi-ai";
import {
	type PersonalizeCatalog,
	type RemoteCatalogOptions,
	type RemoteCatalogRequest,
	withPersonalizedCatalog as withPersonalizedRemoteCatalog,
	withRemoteCatalog as withRemoteCatalogOverlay,
} from "@earendil-works/pi-ai/remote-catalog";
import { VERSION } from "../config.ts";
import { fetchWithRetry } from "../utils/management-http.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";

export {
	type PersonalizeCatalog,
	REMOTE_CATALOG_MODEL_TYPES,
	REMOTE_CATALOG_REFRESH_INTERVAL_MS,
} from "@earendil-works/pi-ai/remote-catalog";

const REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS = 4_000;

/** Catalog requests from pi: retried, with pi's User-Agent. */
const requestCatalog: RemoteCatalogRequest = (url, init) =>
	fetchWithRetry(
		url,
		{ ...init, headers: { ...init.headers, "User-Agent": getPiUserAgent(VERSION) } },
		{ attemptTimeoutMs: REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS },
	);

function catalogOptions(baseUrl: string | undefined, localGeneratedAt: number | undefined): RemoteCatalogOptions {
	return { baseUrl, localGeneratedAt, request: requestCatalog };
}

/** Add a persisted pi.dev catalog overlay to a static built-in provider. */
export function withRemoteCatalog(provider: Provider, catalogBaseUrl?: string, localGeneratedAt?: number): Provider {
	return withRemoteCatalogOverlay(provider, catalogOptions(catalogBaseUrl, localGeneratedAt));
}

/** Like `withRemoteCatalog`, but with a credential-specific catalog; see pi-ai's `withPersonalizedCatalog`. */
export function withPersonalizedCatalog(
	provider: Provider,
	personalize: PersonalizeCatalog,
	catalogBaseUrl?: string,
	localGeneratedAt?: number,
): Provider {
	return withPersonalizedRemoteCatalog(provider, personalize, catalogOptions(catalogBaseUrl, localGeneratedAt));
}
