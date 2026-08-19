/**
 * AI Gateway transport over the Workers AI binding.
 *
 * pi's Cloudflare AI Gateway support speaks HTTPS
 * (`gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}/...`, see `api/cloudflare.ts`),
 * which needs a Cloudflare API token even when the caller is a Worker in the gateway's own
 * account.
 *
 * In order to solve for this problem, `createGatewayBindingFetch` returns a {@link FetchFunction}
 * that translates requests under a gateway HTTPS prefix into calls to the Workers AI binding's
 * universal endpoint, `env.AI.gateway(id).run({provider, endpoint, headers, query})`.
 * Binding calls are pre-authenticated in-account and return the provider's native wire format as a
 * regular (streaming) `Response`, so API implementations behave identically over either
 * transport.
 *
 * The result is the transport for one gateway-bound client, not a general-purpose fetch:
 * requests it cannot serve — URLs outside the prefix, or in-prefix requests the universal
 * endpoint cannot express (non-POST, non-JSON body) — reject with a descriptive error.
 * Transport selection is the caller's job, per client: route such traffic over HTTPS with
 * real gateway auth instead of through this shim.
 */

import type { FetchFunction } from "../types.ts";

/**
 * Structural type for the Workers AI binding's gateway surface (`env.AI`), so this
 * module does not depend on `@cloudflare/workers-types`. Any real `Ai` binding satisfies it.
 */
export interface AiGatewayBinding {
	gateway(id: string): AiGatewayBindingGateway;
}

export interface AiGatewayBindingGateway {
	run(data: AiGatewayUniversalRequestLike, options?: { signal?: AbortSignal }): Promise<Response>;
}

/** One universal-endpoint request entry, as accepted by `AiGateway.run()`. */
export interface AiGatewayUniversalRequestLike {
	provider: string;
	endpoint: string;
	headers: Record<string, string>;
	query: unknown;
}

/**
 * Placeholder value for auth headers on binding-routed requests. API implementations
 * require an API key or a recognized auth header (`authorization`, `x-api-key`,
 * `cf-aig-authorization`) before dispatch; binding calls are pre-authenticated, so pass
 * `cf-aig-authorization: Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}` to satisfy
 * the check. The shim strips `cf-aig-authorization` before calling the binding. Pair it with
 * `Authorization: null` / `x-api-key: null` so the SDKs' placeholder auth headers never reach
 * the gateway, which would treat a request-supplied auth header as a BYOK provider key that
 * overrides its stored keys — the same as it would over HTTPS.
 */
export const CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL = "cloudflare-gateway-binding";

export interface GatewayBindingFetchOptions {
	/** The Workers AI binding (e.g. `env.AI`). */
	binding: AiGatewayBinding;
	/**
	 * Gateway HTTPS prefix every request must fall under, without a trailing slash:
	 * `https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayName}`.
	 */
	baseUrl: string;
	/** Gateway name passed to `binding.gateway()`. Must match the `baseUrl` gateway. */
	gateway: string;
}

// Never forwarded to the binding: hop-by-hop/derived headers, and gateway auth
// (binding calls are pre-authenticated; the sentinel must not reach the wire).
const STRIP_HEADERS = new Set(["content-length", "host", "cf-aig-authorization"]);

type FetchInput = Parameters<FetchFunction>[0];

/**
 * Create a `fetch` that routes AI Gateway requests through the Workers AI binding.
 * See the module docs for behavior and composition notes.
 */
export function createGatewayBindingFetch(options: GatewayBindingFetchOptions): FetchFunction {
	const { binding, gateway } = options;
	// Prefix matching runs on URL-normalized components (origin + pathname), not raw strings:
	// dot segments resolve away and fragments drop, matching what real fetch would put on the
	// wire, so a lexical variant can't split provider/endpoint differently than HTTPS would.
	const base = new URL(options.baseUrl);
	const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;

	return async (input: FetchInput, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? input : undefined;
		const url = request ? request.url : input.toString();
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		let parsed: URL | undefined;
		try {
			parsed = new URL(url);
		} catch {
			parsed = undefined;
		}
		// Out-of-prefix URLs are a configuration bug, not passthrough traffic: silently
		// forwarding would ship the auth sentinel to whatever host the URL names.
		if (parsed === undefined || parsed.origin !== base.origin || !parsed.pathname.startsWith(basePath)) {
			throw new Error(
				`createGatewayBindingFetch: ${method} ${url} is outside the configured gateway ` +
					`prefix (${base.origin}${basePath}); this fetch only serves its gateway-bound client`,
			);
		}

		// In-prefix requests the universal endpoint cannot express always reject: forwarding
		// them over HTTPS would send the sentinel to the gateway and fail with a misleading
		// auth error instead of naming the real problem. Callers that need such endpoints
		// route them over HTTPS with real gateway auth themselves.
		const unexpressible = (reason: string): never => {
			throw new Error(
				`createGatewayBindingFetch: cannot express ${method} ${url} as a universal ` +
					`gateway request (${reason}); route it over HTTPS with gateway auth instead`,
			);
		};
		if (method !== "POST") return unexpressible("only POST is supported");

		const rest = parsed.pathname.slice(basePath.length);
		const slash = rest.indexOf("/");
		if (slash <= 0) {
			return unexpressible("missing provider/endpoint path");
		}
		const provider = rest.slice(0, slash);
		// Keep the query string on the endpoint — it's part of what HTTPS would have sent.
		const endpoint = rest.slice(slash + 1) + parsed.search;

		const bodyText = await readBodyText(request, init);
		let query: unknown;
		try {
			query = bodyText === undefined ? undefined : JSON.parse(bodyText);
		} catch {
			return unexpressible("non-JSON body");
		}
		if (query === undefined) {
			return unexpressible("missing body");
		}

		const headers = collectHeaders(request, init);
		// Per the fetch spec an explicit `signal: null` in init clears a Request input's signal.
		const signal = init?.signal ?? (init && "signal" in init && init.signal === null ? undefined : request?.signal);
		return binding.gateway(gateway).run({ provider, endpoint, headers, query }, signal ? { signal } : {});
	};
}

async function readBodyText(request: Request | undefined, init?: RequestInit): Promise<string | undefined> {
	const body = init?.body;
	if (body === undefined || body === null) {
		// Per the fetch spec an explicit `body: null` in init clears a Request input's body.
		if (init && "body" in init && body === null) return undefined;
		if (request && request.body !== null) return request.clone().text();
		return undefined;
	}
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
	// URLSearchParams, FormData, Blob, ReadableStream in init: read via a Request wrapper.
	// Consuming a one-shot stream here is fine — unexpressible requests reject rather than
	// replay, so nothing downstream needs the body again.
	return new Request("http://body.local", {
		method: "POST",
		body,
		// The fetch spec requires `duplex: "half"` to construct a Request with a stream body
		// (Node's undici enforces it; it is ignored for the replayable body types). TypeScript's
		// RequestInit does not declare the field yet, hence the cast.
		duplex: "half",
	} as RequestInit).text();
}

// Entry header names are lowercased so case-variant duplicates collapse and stripping is
// uniform. Per the fetch spec, `init.headers` replaces a Request input's headers entirely.
function collectHeaders(request: Request | undefined, init?: RequestInit): Record<string, string> {
	const result: Record<string, string> = {};
	const add = (key: string, value: string) => {
		const name = key.toLowerCase();
		if (!STRIP_HEADERS.has(name)) result[name] = value;
	};
	const headers = init?.headers;
	if (headers === undefined) {
		if (request) {
			for (const [key, value] of request.headers) add(key, value);
		}
	} else if (headers instanceof Headers) {
		for (const [key, value] of headers) add(key, value);
	} else if (Array.isArray(headers)) {
		for (const [key, value] of headers) add(key, value);
	} else {
		for (const [key, value] of Object.entries(headers)) {
			if (value !== undefined) add(key, String(value));
		}
	}
	return result;
}
