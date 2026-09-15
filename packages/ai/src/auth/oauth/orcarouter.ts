/**
 * OrcaRouter OAuth 2.0 + PKCE login (Flow A — loopback redirect, with a raced
 * manual-code path for headless sessions).
 *
 * OrcaRouter exchanges an authorization code for a durable, user-owned API key
 * (`sk-orca-…`) rather than an access/refresh token pair. There is no refresh
 * grant: the stored key is reused until OrcaRouter revokes it, and a `401` from
 * the relay means "run this flow again", never "refresh".
 *
 * Network policy:
 * - authorization and the code exchange use the auth origin
 *   (`https://www.orcarouter.ai`, `/auth` and `/api/v1/auth/keys`);
 * - inference and model discovery use the inference origin
 *   (`https://api.orcarouter.ai/v1`).
 * The two origins are configured independently and are never derived from each
 * other. Non-loopback origins must be HTTPS.
 *
 * NOTE: Node-only module (`node:http` callback server, `node:crypto`). Loaded
 * through a bundler-opaque dynamic import by the provider definition.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";

/** Default authentication origin. Public default; never derived from the API origin. */
export const ORCAROUTER_DEFAULT_AUTH_BASE_URL = "https://www.orcarouter.ai";
const AUTHORIZE_PATH = "/auth";
const EXCHANGE_PATH = "/api/v1/auth/keys";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 30_000;
/** The only scope this integration can use: the key must reach the inference relay. */
const REQUIRED_SCOPE = "api";

type JsonObject = Record<string, unknown>;

function getCallbackHost(): string {
	return getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
}

/**
 * Resolve the authentication origin. Explicit `ORCA_AUTH_BASE_URL` wins, then
 * the shared self-hosted `ORCA_BASE_URL`, then the public default.
 */
export function resolveOrcaRouterAuthBaseUrl(env?: Record<string, string | undefined>): string {
	const explicit =
		(env ? env.ORCA_AUTH_BASE_URL : undefined) ??
		getProviderEnvValue("ORCA_AUTH_BASE_URL") ??
		(env ? env.ORCA_BASE_URL : undefined) ??
		getProviderEnvValue("ORCA_BASE_URL");
	return explicit || ORCAROUTER_DEFAULT_AUTH_BASE_URL;
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Reject a remote origin that is not HTTPS. Loopback development may use HTTP.
 * Throws with an actionable message rather than silently sending credentials
 * over cleartext.
 */
export function assertSecureOrigin(rawUrl: string, label: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`${label} is not a valid URL`);
	}
	if (url.protocol === "https:") return url;
	if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
	throw new Error(`${label} must use HTTPS (HTTP is only allowed for loopback development hosts)`);
}

/** Constant-time comparison for the OAuth `state` echo. */
function stateMatches(received: string | null, expected: string): boolean {
	if (received === null) return false;
	const receivedBytes = Buffer.from(received, "utf-8");
	const expectedBytes = Buffer.from(expected, "utf-8");
	if (receivedBytes.length !== expectedBytes.length) return false;
	return timingSafeEqual(receivedBytes, expectedBytes);
}

/**
 * The consent screen reports a denial through `error`/`error_description`.
 * Unlike an exchange result, a denial description is user-facing prose from the
 * auth origin and carries no credential material, so it is safe to surface.
 */
function denialDescription(url: URL): string {
	return url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "access_denied";
}

/**
 * Map an exchange failure onto an actionable, credential-free message. The
 * response body never reaches the message: it can echo request material.
 */
function exchangeFailureMessage(status: number): string {
	switch (status) {
		case 400:
			return "OrcaRouter rejected the authorization request (HTTP 400): the PKCE challenge method was refused or did not match the one sent at authorize time.";
		case 403:
			return "OrcaRouter rejected the authorization code (HTTP 403): it is unknown, expired, already used, or does not match this device's code verifier. Start the login again.";
		case 429:
			return "OrcaRouter rate-limited authorization (HTTP 429). A user may issue at most 10 keys per 24 hours; reuse the stored key instead of signing in again.";
		default:
			return `OrcaRouter key exchange failed (HTTP ${status}).`;
	}
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	authBaseUrl: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	if (signal.aborted) throw new Error("Login cancelled");
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(
		() => controller.abort(new Error("OrcaRouter key exchange timed out")),
		EXCHANGE_TIMEOUT_MS,
	);

	let response: Response;
	let body: JsonObject = {};
	try {
		response = await fetch(new URL(EXCHANGE_PATH, authBaseUrl), {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
			signal: controller.signal,
		});
		try {
			const parsed = (await response.json()) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as JsonObject;
		} catch {
			if (response.ok) throw new Error("OrcaRouter key exchange returned invalid JSON");
		}
	} catch (error) {
		if (signal.aborted) throw new Error("Login cancelled");
		if (controller.signal.aborted) throw new Error("OrcaRouter key exchange timed out");
		throw error;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", onAbort);
	}

	if (!response.ok) throw new Error(exchangeFailureMessage(response.status));

	const key = body.key;
	if (typeof key !== "string" || key.length === 0) {
		throw new Error('OrcaRouter key exchange response carries no "key"');
	}

	// Read back the *granted* scope, not the requested one. A narrower grant
	// cannot drive inference, so surface it instead of storing an unusable key.
	const grantedScope = typeof body.scope === "string" ? body.scope : undefined;
	if (grantedScope !== REQUIRED_SCOPE) {
		throw new Error(
			`OrcaRouter granted scope "${grantedScope ?? "unknown"}" but this integration requires "${REQUIRED_SCOPE}" to reach the inference API. Ask a workspace owner to approve the wider grant.`,
		);
	}

	return {
		type: "oauth",
		// A durable API key, not an expiring access token: reuse until revoked.
		access: key,
		// OrcaRouter issues no refresh token. The field is part of the shared
		// credential shape; nothing refreshes it and no refresh grant exists.
		refresh: "",
		expires: Number.MAX_SAFE_INTEGER,
		scope: grantedScope,
	};
}

type OrcaRouterCallbackServer = {
	callbackUrl: string;
	close: () => void;
	cancelWait: () => void;
	waitForCredential: () => Promise<OAuthCredential | null>;
};

function sendHtml(response: ServerResponse, status: number, html: string): void {
	response.statusCode = status;
	response.setHeader("content-type", "text/html; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.end(html);
}

/** Accept either a bare code, a pasted redirect URL, or a `code=...` fragment. */
function parseAuthorizationInput(input: string): string | undefined {
	const value = input.trim();
	if (!value) return undefined;
	try {
		return new URL(value).searchParams.get("code") ?? undefined;
	} catch {
		// not a URL
	}
	if (value.includes("code=")) return new URLSearchParams(value).get("code") ?? undefined;
	return value;
}

async function startCallbackServer(
	callbackPath: string,
	verifier: string,
	state: string,
	authBaseUrl: string,
	signal: AbortSignal,
): Promise<OrcaRouterCallbackServer> {
	if (signal.aborted) throw new Error("Login cancelled");
	const callbackHost = getCallbackHost();
	let resolveCredential: (credential: OAuthCredential | null) => void = () => {};
	let rejectCredential: (error: Error) => void = () => {};
	const credential = new Promise<OAuthCredential | null>((resolve, reject) => {
		resolveCredential = resolve;
		rejectCredential = reject;
	});

	let server: Server;
	let claimed = false;
	let settled = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;

	const close = (): void => {
		if (timeout) clearTimeout(timeout);
		if (onAbort) signal.removeEventListener("abort", onAbort);
		server.close();
	};

	const finish = (result: { credential: OAuthCredential | null } | { error: Error }): void => {
		if (settled) return;
		settled = true;
		close();
		if ("credential" in result) resolveCredential(result.credential);
		else rejectCredential(result.error);
	};

	server = createServer((request, response) => {
		void (async () => {
			const requestUrl = new URL(request.url ?? "/", `http://${callbackHost}`);
			if (request.method !== "GET" || requestUrl.pathname !== callbackPath) {
				sendHtml(response, 404, oauthErrorHtml("OAuth callback route not found."));
				return;
			}
			if (claimed || settled) {
				sendHtml(response, 409, oauthErrorHtml("This OAuth callback has already been used."));
				return;
			}

			// Compare state before touching the code, and before any exchange.
			if (!stateMatches(requestUrl.searchParams.get("state"), state)) {
				sendHtml(response, 400, oauthErrorHtml("OrcaRouter authorization state did not match."));
				finish({ error: new Error("OrcaRouter authorization state mismatch") });
				return;
			}

			const oauthError = requestUrl.searchParams.get("error");
			if (oauthError) {
				const description = denialDescription(requestUrl);
				sendHtml(response, 400, oauthErrorHtml("OrcaRouter authorization was denied.", description));
				finish({ error: new Error(`OrcaRouter authorization failed: ${description}`) });
				return;
			}

			const code = requestUrl.searchParams.get("code");
			if (!code) {
				sendHtml(response, 400, oauthErrorHtml("OrcaRouter returned no authorization code."));
				return;
			}
			claimed = true;

			try {
				const result = await exchangeAuthorizationCode(code, verifier, authBaseUrl, signal);
				sendHtml(response, 200, oauthSuccessHtml("Signed in to OrcaRouter. You may now close this page."));
				finish({ credential: result });
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown key exchange error";
				sendHtml(response, 502, oauthErrorHtml("OrcaRouter key exchange failed.", message));
				finish({ error: error instanceof Error ? error : new Error(message) });
			}
		})();
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, callbackHost, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	server.on("error", (error) => finish({ error }));
	onAbort = () => finish({ error: new Error("Login cancelled") });
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) {
		close();
		throw new Error("Login cancelled");
	}
	timeout = setTimeout(() => finish({ error: new Error("OrcaRouter login timed out") }), LOGIN_TIMEOUT_MS);

	const address = server.address();
	if (!address || typeof address === "string") {
		close();
		throw new Error("Could not determine the OrcaRouter OAuth callback port");
	}

	return {
		callbackUrl: `http://${callbackHost}:${address.port}${callbackPath}`,
		close,
		// A claimed callback is already exchanging its code; let that settle the login.
		cancelWait: () => {
			if (!claimed) finish({ credential: null });
		},
		waitForCredential: () => credential,
	};
}

async function loginOrcaRouter(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const authBaseUrl = resolveOrcaRouterAuthBaseUrl();
	assertSecureOrigin(authBaseUrl, "OrcaRouter auth base URL");

	// Fresh verifier, challenge, and state from a cryptographic RNG for every attempt.
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	const callbackPath = `/oauth/callback/${crypto.randomUUID()}`;
	const callback = await startCallbackServer(callbackPath, verifier, state, authBaseUrl, interaction.signal);
	const manualAbort = new AbortController();
	let manualInput: string | undefined;
	let manualError: Error | undefined;

	try {
		const authorizeUrl = new URL(AUTHORIZE_PATH, authBaseUrl);
		authorizeUrl.search = new URLSearchParams({
			callback_url: callback.callbackUrl,
			code_challenge: challenge,
			// Always S256: the consent screen lets the user choose "show me a code"
			// even when a callback URL is supplied.
			code_challenge_method: "S256",
			state,
			app_name: "pi",
			scope: REQUIRED_SCOPE,
		}).toString();

		interaction.notify({
			type: "progress",
			message: `Listening for OrcaRouter OAuth callback on ${callback.callbackUrl}`,
		});
		interaction.notify({
			type: "auth_url",
			url: authorizeUrl.toString(),
			instructions:
				"Complete sign-in in your browser. If the browser is on another machine, paste the code or the redirect URL here.",
		});

		const manualPromise = interaction
			.prompt({
				type: "manual_code",
				message: "Complete sign-in in your browser, or paste the authorization code / redirect URL here:",
				placeholder: callback.callbackUrl,
				signal: manualAbort.signal,
			})
			.then((input) => {
				manualInput = input;
				callback.cancelWait();
			})
			.catch((error) => {
				manualError = error instanceof Error ? error : new Error(String(error));
				callback.cancelWait();
			});

		const credential = await callback.waitForCredential();
		if (manualError) throw manualError;
		if (credential) return credential;

		await manualPromise;
		if (manualError) throw manualError;
		const code = manualInput ? parseAuthorizationInput(manualInput) : undefined;
		if (!code) throw new Error("Missing OrcaRouter authorization code");
		interaction.notify({ type: "progress", message: "Exchanging authorization code for an OrcaRouter API key..." });
		return await exchangeAuthorizationCode(code, verifier, authBaseUrl, interaction.signal);
	} finally {
		manualAbort.abort();
		callback.close();
	}
}

export const orcaRouterOAuth: OAuthAuth = {
	name: "OrcaRouter OAuth",
	loginLabel: "Sign in with OrcaRouter",
	login: loginOrcaRouter,
	async refresh(credential, _signal) {
		// OrcaRouter issues a durable API key and exposes no refresh grant.
		// Returning the credential unchanged keeps the shared refresh path inert
		// instead of inventing a rotation the provider cannot perform.
		return credential;
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
