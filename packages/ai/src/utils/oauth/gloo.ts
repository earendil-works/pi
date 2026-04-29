/**
 * Gloo AI OAuth2 client_credentials provider.
 *
 * Unlike Anthropic / GitHub Copilot / Google Gemini CLI / Antigravity /
 * OpenAI Codex — which all use browser-launched PKCE flows — Gloo's
 * `/oauth2/token` endpoint uses the **client_credentials** grant. There's
 * no browser dance: the user gets a static `(client_id, client_secret)`
 * pair from `https://studio.ai.gloo.com/api-credentials`, and the bearer
 * is minted on demand by the API.
 *
 * Despite that, the integration into pi-mono's OAuth registry stays
 * uniform: this module exposes a `glooOAuthProvider` that implements
 * `OAuthProviderInterface` so it shows up alongside the others in
 * `/login` ("Gloo AI · unconfigured"), drives credential collection via
 * the same `OAuthLoginCallbacks.onPrompt` path the manual-code flows
 * already use, and persists `OAuthCredentials` in the same store. The
 * difference is that `refresh` here holds the long-lived `client_secret`
 * (used to mint new bearers) and `access` holds the short-lived bearer.
 *
 * Two consumption paths are supported:
 *   1. Interactive — user runs `/login`, picks "Gloo AI", pastes
 *      client_id + client_secret, and the registry persists creds.
 *      pi-coding-agent's auth-storage layer feeds `getApiKey(creds)`
 *      (the bearer) into model requests as `options.apiKey`.
 *   2. Headless / CI — `GLOO_CLIENT_ID` + `GLOO_CLIENT_SECRET` are set
 *      in the environment. `getGlooAccessToken()` mints from env and
 *      caches; the gloo provider wrapper falls back to this when
 *      `options.apiKey` is absent.
 *
 * Both paths share the percent-encoded Basic auth helper so credentials
 * with reserved characters (`:`, `+`, `=`, `&`) round-trip cleanly.
 */

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

// ============================================================================
// Public types
// ============================================================================

export interface GlooTokenCache {
	accessToken: string;
	expiresAt: number;
}

export interface GlooTokenOptions {
	/** Defaults to `process.env.GLOO_CLIENT_ID`. */
	clientId?: string;
	/** Defaults to `process.env.GLOO_CLIENT_SECRET`. */
	clientSecret?: string;
	/** Defaults to `process.env.GLOO_BASE_URL ?? "https://platform.ai.gloo.com"`. */
	baseUrl?: string;
	/** OAuth scope. Defaults to `"api/access"`. */
	scope?: string;
	/** Optional AbortSignal for the underlying token fetch. */
	signal?: AbortSignal;
}

/**
 * Persisted credential shape for the Gloo provider.
 *
 * `OAuthCredentials` is intentionally permissive — additional fields
 * are passed through. We document the contract here so future readers
 * (including a possible upstream PR reviewer) know what to expect.
 *
 * - `refresh` — the user-supplied `client_secret`. Long-lived; used to
 *   mint new bearers via the OAuth2 client_credentials grant.
 * - `access` — the most recently minted bearer JWT.
 * - `expires` — bearer expiry (Unix ms), with the same 60s safety
 *   margin used elsewhere.
 * - `clientId` — the user-supplied `client_id`. Needed alongside the
 *   `client_secret` to mint a fresh bearer.
 * - `baseUrl` — the Gloo platform base URL the client was issued for
 *   (typically `https://platform.ai.gloo.com`). Stored on creds so a
 *   user who logged in once against staging doesn't accidentally use
 *   those creds against prod.
 * - `label` — optional display label for the single stored credential
 *   (e.g. `personal`, `servant-internal`). Re-running `/login` replaces
 *   the previous single-slot credential.
 */
export interface GlooOAuthCredentials extends OAuthCredentials {
	clientId: string;
	baseUrl: string;
	label?: string;
}

// ============================================================================
// Constants and shared helpers
// ============================================================================

const DEFAULT_BASE_URL = "https://platform.ai.gloo.com";
const DEFAULT_SCOPE = "api/access";
const DEFAULT_TOKEN_TTL_SEC = 3600;
const EXPIRY_SAFETY_MARGIN_SEC = 60;
const STUDIO_CREDENTIALS_URL = "https://studio.ai.gloo.com/api-credentials";

function isLocalUrl(url: string): boolean {
	return url.includes("localhost") || url.includes("127.0.0.1");
}

function normalizeBaseUrl(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

function buildBasicAuthHeader(clientId: string, clientSecret: string): string {
	// Match the verify-gloo and install-flow encoding contract: percent-encode
	// each field individually, join with `:`, then base64. btoa is available
	// everywhere; Buffer is preferred in Node/Bun to avoid surrogate issues.
	const encoded = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
	if (typeof Buffer !== "undefined") {
		return `Basic ${Buffer.from(encoded).toString("base64")}`;
	}
	return `Basic ${btoa(encoded)}`;
}

interface TokenResponse {
	access_token: string;
	expires_in?: number;
	token_type?: string;
}

interface FetchTokenOpts {
	baseUrl: string;
	clientId: string;
	clientSecret: string;
	scope: string;
	signal?: AbortSignal;
}

/**
 * Low-level token-grant helper. Returns the cache-shaped tuple used by
 * both the in-memory cache below and the persisted `OAuthCredentials`
 * lifecycle.
 *
 * Local-mode (`baseUrl` pointing at localhost/127.0.0.1) skips the
 * `/oauth2/token` exchange entirely — local `ai-api` running with
 * `ENVIRONMENT=local` accepts any Bearer; we use the `client_id` as
 * the bearer to keep the rest of the pipeline uniform.
 */
async function fetchGlooToken(opts: FetchTokenOpts): Promise<GlooTokenCache> {
	const { baseUrl, clientId, clientSecret, scope, signal } = opts;

	if (isLocalUrl(baseUrl)) {
		return {
			accessToken: clientId,
			expiresAt: Date.now() + DEFAULT_TOKEN_TTL_SEC * 1000,
		};
	}

	const tokenUrl = `${baseUrl}/oauth2/token`;
	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Authorization: buildBasicAuthHeader(clientId, clientSecret),
		},
		body: new URLSearchParams({
			grant_type: "client_credentials",
			scope,
		}),
		signal,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		const idPrefix = `${clientId.slice(0, 8)}…`;
		throw new Error(
			`Gloo AI token request failed (${response.status} ${response.statusText}) for client ${idPrefix}: ${text.slice(0, 300)}`,
		);
	}

	const data = (await response.json()) as TokenResponse;
	if (!data.access_token) {
		throw new Error("Gloo AI token response missing access_token");
	}

	const expiresInSec = data.expires_in ?? DEFAULT_TOKEN_TTL_SEC;
	return {
		accessToken: data.access_token,
		expiresAt: Date.now() + (expiresInSec - EXPIRY_SAFETY_MARGIN_SEC) * 1000,
	};
}

// ============================================================================
// Headless / env-driven path — used by the gloo provider wrapper as a
// fallback when `options.apiKey` is not supplied by the auth-storage layer.
// ============================================================================

// Cache scoped per-(baseUrl, clientId) so multiple Gloo tenants in the
// same process don't stomp each other's tokens.
const tokenCache = new Map<string, GlooTokenCache>();
const pendingRequests = new Map<string, Promise<string>>();

function cacheKey(baseUrl: string, clientId: string): string {
	return `${baseUrl}::${clientId}`;
}

/**
 * Resolve a valid Gloo bearer token from environment variables (or
 * explicit `options`), refreshing if expired and coalescing concurrent
 * requests for the same `(baseUrl, clientId)` pair.
 *
 * This is the headless code path. The interactive `/login` flow persists
 * creds and feeds the bearer in via `options.apiKey` directly; this
 * helper is the fallback for CI / scripted use where env vars are set.
 *
 * Throws if credentials are missing or the platform rejects them.
 */
export async function getGlooAccessToken(options: GlooTokenOptions = {}): Promise<string> {
	const clientId = options.clientId ?? process.env.GLOO_CLIENT_ID;
	const clientSecret = options.clientSecret ?? process.env.GLOO_CLIENT_SECRET;
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.GLOO_BASE_URL ?? DEFAULT_BASE_URL);
	const scope = options.scope ?? DEFAULT_SCOPE;

	if (!clientId) {
		throw new Error(
			"Gloo AI is not configured: GLOO_CLIENT_ID is missing. Run /login → Gloo AI to set up credentials.",
		);
	}
	if (!clientSecret && !isLocalUrl(baseUrl)) {
		throw new Error(
			"Gloo AI is not configured: GLOO_CLIENT_SECRET is missing. Run /login → Gloo AI to set up credentials.",
		);
	}

	const key = cacheKey(baseUrl, clientId);
	const cached = tokenCache.get(key);
	if (cached && Date.now() < cached.expiresAt) {
		return cached.accessToken;
	}

	const inFlight = pendingRequests.get(key);
	if (inFlight) {
		return inFlight;
	}

	const promise = fetchGlooToken({
		baseUrl,
		clientId,
		clientSecret: clientSecret ?? clientId, // local-mode tolerates either
		scope,
		signal: options.signal,
	})
		.then((entry) => {
			tokenCache.set(key, entry);
			return entry.accessToken;
		})
		.finally(() => {
			pendingRequests.delete(key);
		});

	pendingRequests.set(key, promise);
	return promise;
}

/**
 * Clear cached Gloo tokens. Useful for tests or after rotating credentials.
 *
 * Pass `(baseUrl, clientId)` to clear a single tenant; omit both to clear
 * everything.
 */
export function clearGlooTokenCache(baseUrl?: string, clientId?: string): void {
	if (!baseUrl || !clientId) {
		tokenCache.clear();
		pendingRequests.clear();
		return;
	}
	const key = cacheKey(normalizeBaseUrl(baseUrl), clientId);
	tokenCache.delete(key);
	pendingRequests.delete(key);
}

/**
 * Inspect the current Gloo token cache. Test/debug helper — do not rely
 * on this from production code.
 */
export function getGlooTokenCache(baseUrl: string, clientId: string): GlooTokenCache | undefined {
	return tokenCache.get(cacheKey(normalizeBaseUrl(baseUrl), clientId));
}

// ============================================================================
// Interactive /login path — implements OAuthProviderInterface
// ============================================================================

/**
 * Walk the user through pasting `(client_id, client_secret)`, validate the
 * pair with a live token grant, and return a fully-populated
 * `OAuthCredentials` ready for the registry to persist.
 *
 * Mirrors the shape of the other login* helpers in this directory so it
 * can be exported as a sibling — `loginAnthropic`, `loginGitHubCopilot`,
 * etc. The TUI's `OAuthLoginCallbacks` already drives one-line prompts
 * (Anthropic uses it for the manual code redirect), so two consecutive
 * prompts work without any UI changes.
 */
export async function loginGloo(callbacks: OAuthLoginCallbacks): Promise<GlooOAuthCredentials> {
	const baseUrl = normalizeBaseUrl(process.env.GLOO_BASE_URL ?? DEFAULT_BASE_URL);

	callbacks.onAuth({
		url: STUDIO_CREDENTIALS_URL,
		instructions:
			"Sign in to Gloo Studio, create or copy a client credential, and paste the values below. " +
			"The client_secret is shown only at creation time — copy it before closing the dialog.",
	});

	const clientId = (await callbacks.onPrompt({ message: "Paste your Gloo client_id:" })).trim();
	if (!clientId) {
		throw new Error("Gloo client_id is required");
	}

	const clientSecret = (await callbacks.onPrompt({ message: "Paste your Gloo client_secret:" })).trim();
	if (!clientSecret) {
		throw new Error("Gloo client_secret is required");
	}

	const label = (
		await callbacks.onPrompt({
			message: "Optional label for this Gloo credential (e.g. personal, servant-internal):",
		})
	).trim();

	callbacks.onProgress?.(`Validating credentials against ${baseUrl}…`);

	let tokenEntry: GlooTokenCache;
	try {
		tokenEntry = await fetchGlooToken({
			baseUrl,
			clientId,
			clientSecret,
			scope: DEFAULT_SCOPE,
			signal: callbacks.signal,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Gloo credentials were rejected by ${baseUrl}. ` +
				`Double-check the values from ${STUDIO_CREDENTIALS_URL} and try again.\n` +
				`  Underlying error: ${message}`,
		);
	}

	callbacks.onProgress?.("Gloo credentials validated.");

	// Seed the in-memory cache too so the headless path can reuse the
	// freshly minted bearer if it's invoked in the same process before
	// expiry (e.g. tests that exercise both paths).
	tokenCache.set(cacheKey(baseUrl, clientId), tokenEntry);

	return {
		clientId,
		baseUrl,
		...(label ? { label } : {}),
		refresh: clientSecret,
		access: tokenEntry.accessToken,
		expires: tokenEntry.expiresAt,
	};
}

/**
 * Re-mint the bearer using the persisted `client_id` + `client_secret`.
 *
 * Called by the registry whenever `Date.now() >= credentials.expires`.
 * Returns updated credentials (same `client_id` / `client_secret`,
 * fresh `access` and `expires`).
 */
export async function refreshGlooToken(credentials: OAuthCredentials): Promise<GlooOAuthCredentials> {
	const clientId = readString(credentials, "clientId");
	const baseUrl = normalizeBaseUrl(readString(credentials, "baseUrl") || DEFAULT_BASE_URL);
	const clientSecret = credentials.refresh;
	if (!clientId) {
		throw new Error("Gloo credentials are corrupted: missing clientId. Re-run /login → Gloo AI.");
	}
	if (!clientSecret) {
		throw new Error("Gloo credentials are corrupted: missing refresh (client_secret). Re-run /login → Gloo AI.");
	}

	const entry = await fetchGlooToken({
		baseUrl,
		clientId,
		clientSecret,
		scope: DEFAULT_SCOPE,
	});

	tokenCache.set(cacheKey(baseUrl, clientId), entry);

	const label = readString(credentials, "label");

	return {
		clientId,
		baseUrl,
		...(label ? { label } : {}),
		refresh: clientSecret,
		access: entry.accessToken,
		expires: entry.expiresAt,
	};
}

function readString(credentials: OAuthCredentials, key: string): string {
	const value = credentials[key];
	return typeof value === "string" ? value : "";
}

/**
 * Pi-mono OAuth provider entry for Gloo AI.
 *
 * Registered in `BUILT_IN_OAUTH_PROVIDERS` so it shows up automatically
 * in `/login` ("Gloo AI · unconfigured") next to the other providers,
 * with no changes required to the TUI picker.
 */
export const glooOAuthProvider: OAuthProviderInterface = {
	id: "gloo",
	name: "Gloo AI",
	// No callback server — Gloo's OAuth2 client_credentials grant doesn't
	// involve a redirect URI, so manual-code-input UX doesn't apply here.
	usesCallbackServer: false,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginGloo(callbacks);
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshGlooToken(credentials);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
