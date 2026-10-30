// The relay: provider auth requests that browsers cannot send directly, forwarded by pi.dev.

import type { OAuthFetch } from "@earendil-works/pi-ai/oauth-flows";

/**
 * Some providers' auth endpoints send no CORS headers, so a browser cannot read their responses.
 * pi.dev forwards requests to exactly these endpoints and stores nothing: no database, no logs of
 * bodies. The list below is both the client's routing table and pi.dev's allowlist (pi.dev generates
 * its copy from this file).
 *
 * Example: Anthropic's token refresh is `POST https://platform.claude.com/v1/oauth/token`. In a
 * browser, `relayFetch("https://pi.dev")` sends it as
 * `POST https://pi.dev/api/oauth/relay?url=https%3A%2F%2Fplatform.claude.com%2Fv1%2Foauth%2Ftoken`
 * with the same headers and body, and returns Anthropic's answer.
 */

/**
 * Who may send a relayed request. `connect`: only pi.dev's sign-in popup, so every sign-in passes
 * the page that shows the user which site receives the credential. `any`: any page, for token
 * refreshes, which need a credential the page already holds.
 */
export type RelayAccess = "connect" | "any";

export interface RelayEndpoint {
	provider: string;
	method: "GET" | "POST";
	/** Exact URL, without a query. */
	url: string;
	/**
	 * One rule for the endpoint, or a rule per OAuth `grant_type` of the request body for token
	 * endpoints that serve both sign-in and refresh. The relay refuses other grant types.
	 */
	access: RelayAccess | Readonly<Record<string, RelayAccess>>;
	/** Request headers the relay forwards besides `accept` and `content-type`. */
	headers?: readonly string[];
}

/** The path of the relay on pi.dev; the target goes in the `url` query parameter. */
export const RELAY_PATH = "/api/oauth/relay";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const GITHUB_HEADERS = ["user-agent"];

/** Every endpoint the relay forwards to. */
export const RELAY_ENDPOINTS: readonly RelayEndpoint[] = [
	{
		provider: "anthropic",
		method: "POST",
		url: "https://platform.claude.com/v1/oauth/token",
		access: { authorization_code: "connect", refresh_token: "any" },
	},
	{
		provider: "github-copilot",
		method: "POST",
		url: "https://github.com/login/device/code",
		access: "connect",
		headers: GITHUB_HEADERS,
	},
	{
		provider: "github-copilot",
		method: "POST",
		url: "https://github.com/login/oauth/access_token",
		access: "connect",
		headers: GITHUB_HEADERS,
	},
	{
		provider: "github-copilot",
		method: "GET",
		url: "https://api.github.com/copilot_internal/v2/token",
		access: "any",
		headers: [
			...GITHUB_HEADERS,
			"authorization",
			"editor-version",
			"editor-plugin-version",
			"copilot-integration-id",
		],
	},
	{ provider: "xai", method: "POST", url: "https://auth.x.ai/oauth2/device/code", access: "connect" },
	{
		provider: "xai",
		method: "POST",
		url: "https://auth.x.ai/oauth2/token",
		access: { [DEVICE_CODE_GRANT]: "connect", refresh_token: "any" },
	},
	{ provider: "meta", method: "POST", url: "https://auth.meta.com/oidc/device/authorization/", access: "connect" },
	{ provider: "meta", method: "POST", url: "https://auth.meta.com/oidc/device/token/", access: "connect" },
	{
		provider: "meta",
		method: "POST",
		url: "https://api.meta.ai/muse-code/key",
		access: "any",
		headers: ["authorization", "x-api-version"],
	},
];

/** A fetch that sends requests to relayed endpoints through the relay at `relayOrigin`, all others directly. */
export function relayFetch(relayOrigin: string): OAuthFetch {
	return (input, init) => {
		const url = new URL(input);
		if (!findRelayEndpoint(url, init?.method ?? "GET")) return fetch(input, init);
		const relayed = new URL(RELAY_PATH, relayOrigin);
		relayed.searchParams.set("url", url.href);
		return fetch(relayed, init);
	};
}

/** The relayed endpoint a request goes to, if any. */
export function findRelayEndpoint(url: URL, method: string): RelayEndpoint | undefined {
	if (url.search || url.hash) return undefined;
	const target = `${url.origin}${url.pathname}`;
	const upper = method.toUpperCase();
	return RELAY_ENDPOINTS.find((endpoint) => endpoint.url === target && endpoint.method === upper);
}
