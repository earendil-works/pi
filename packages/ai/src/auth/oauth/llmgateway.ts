/**
 * LLM Gateway browser sign-in flow.
 *
 * LLM Gateway has no OAuth token endpoint; instead its dashboard mints an API
 * key and delivers it straight to a loopback callback
 * (`https://llmgateway.io/connect/cli?callback=...&state=...`). The callback is
 * handled by a one-shot loopback server on an ephemeral port, raced against a
 * manual prompt so remote/headless sessions can paste the redirect URL (or the
 * key itself) when the browser cannot reach the loopback server. A `state`
 * parameter echoed by the dashboard guards against CSRF.
 *
 * Minted keys are valid for 90 days and cannot be refreshed; when a key
 * expires the API returns 401 and the user has to sign in again.
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { AuthInteraction, OAuthAuth, OAuthCredential } from "../types.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";

const AUTHORIZE_URL = "https://llmgateway.io/connect/cli";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function getCallbackHost(): string {
	return getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
}

type LlmGatewayCallbackServer = {
	callbackUrl: string;
	/** Stop listening and release timers without settling `waitForCredential`. */
	close: () => void;
	/** Hand the login over to manual entry unless a callback already settled it. */
	cancelWait: () => void;
	/**
	 * Resolves with the credential once a browser callback delivers the minted
	 * key, or with null once `cancelWait` hands the login over to manual entry.
	 * Rejects on timeout, cancellation, or a denied authorization.
	 */
	waitForCredential: () => Promise<OAuthCredential | null>;
};

function sendHtml(response: ServerResponse, status: number, html: string): void {
	response.statusCode = status;
	response.setHeader("content-type", "text/html; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.end(html);
}

function keyCredential(key: string): OAuthCredential {
	return {
		type: "oauth",
		access: key,
		refresh: "",
		expires: Number.MAX_SAFE_INTEGER,
	};
}

function parseManualKeyInput(input: string, expectedState: string): string | undefined {
	const value = input.trim();
	if (!value) return undefined;

	let params: URLSearchParams | undefined;
	try {
		params = new URL(value).searchParams;
	} catch {
		// not a URL
	}
	if (!params && value.includes("key=")) {
		params = new URLSearchParams(value);
	}
	if (!params) return value;

	const state = params.get("state");
	if (state !== null && state !== expectedState) {
		throw new Error("State mismatch in pasted callback URL");
	}
	return params.get("key") ?? undefined;
}

async function startCallbackServer(
	callbackPath: string,
	expectedState: string,
	signal?: AbortSignal,
): Promise<LlmGatewayCallbackServer> {
	if (signal?.aborted) throw new Error("Login cancelled");
	const callbackHost = getCallbackHost();
	let resolveCredential: (credential: OAuthCredential | null) => void = () => {};
	let rejectCredential: (error: Error) => void = () => {};
	const credential = new Promise<OAuthCredential | null>((resolve, reject) => {
		resolveCredential = resolve;
		rejectCredential = reject;
	});

	let server: Server;
	let settled = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;

	const close = (): void => {
		if (timeout) clearTimeout(timeout);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
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
		const requestUrl = new URL(request.url ?? "/", `http://${callbackHost}`);
		if (request.method !== "GET" || requestUrl.pathname !== callbackPath) {
			sendHtml(response, 404, oauthErrorHtml("OAuth callback route not found."));
			return;
		}
		if (settled) {
			sendHtml(response, 409, oauthErrorHtml("This OAuth callback has already been used."));
			return;
		}

		// A CSRF-suspect request must neither consume nor settle the login —
		// including error callbacks, which would otherwise let a forged request
		// terminate a pending login.
		if (requestUrl.searchParams.get("state") !== expectedState) {
			sendHtml(response, 400, oauthErrorHtml("State mismatch. Restart the login and try again."));
			return;
		}

		const oauthError = requestUrl.searchParams.get("error");
		if (oauthError) {
			const description = requestUrl.searchParams.get("error_description") ?? oauthError;
			sendHtml(response, 400, oauthErrorHtml("LLM Gateway authorization was denied.", description));
			finish({ error: new Error(`LLM Gateway authorization failed: ${description}`) });
			return;
		}

		const key = requestUrl.searchParams.get("key");
		if (!key) {
			sendHtml(response, 400, oauthErrorHtml("LLM Gateway returned no API key."));
			return;
		}

		sendHtml(response, 200, oauthSuccessHtml("Signed in to LLM Gateway. You may now close this page."));
		finish({ credential: keyCredential(key) });
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
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) {
		close();
		throw new Error("Login cancelled");
	}
	timeout = setTimeout(() => finish({ error: new Error("LLM Gateway login timed out") }), LOGIN_TIMEOUT_MS);

	const address = server.address();
	if (!address || typeof address === "string") {
		close();
		throw new Error("Could not determine the LLM Gateway OAuth callback port");
	}

	return {
		callbackUrl: `http://${callbackHost}:${address.port}${callbackPath}`,
		close,
		cancelWait: () => finish({ credential: null }),
		waitForCredential: () => credential,
	};
}

async function loginLlmGateway(interaction: AuthInteraction): Promise<OAuthCredential> {
	const state = crypto.randomUUID();
	const callbackPath = `/oauth/callback/${crypto.randomUUID()}`;
	const callback = await startCallbackServer(callbackPath, state, interaction.signal);
	const manualAbort = new AbortController();
	let manualInput: string | undefined;
	let manualError: Error | undefined;

	try {
		const authorizeUrl = new URL(AUTHORIZE_URL);
		authorizeUrl.search = new URLSearchParams({
			callback: callback.callbackUrl,
			state,
			source: "pi-agent",
			name: "Pi coding agent",
		}).toString();

		interaction.notify({
			type: "progress",
			message: `Listening for LLM Gateway callback on ${callback.callbackUrl}`,
		});
		interaction.notify({
			type: "auth_url",
			url: authorizeUrl.toString(),
			instructions:
				"Complete sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		const manualPromise = interaction
			.prompt({
				type: "manual_code",
				message: "Complete sign-in in your browser, or paste the redirect URL / API key here:",
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
		const key = manualInput ? parseManualKeyInput(manualInput, state) : undefined;
		if (!key) throw new Error("Missing API key");
		return keyCredential(key);
	} finally {
		manualAbort.abort();
		callback.close();
	}
}

export const llmGatewayOAuth: OAuthAuth = {
	name: "LLMGateway OAuth",
	loginLabel: "Sign in with LLM Gateway",
	login: loginLlmGateway,
	// The minted key cannot be refreshed; it stays valid for 90 days and the
	// user signs in again once the API starts returning 401.
	async refresh(credential) {
		return credential;
	},
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
