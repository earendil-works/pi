/**
 * OpenAI Responses API token sharing through Sign in with ChatGPT.
 *
 * This public-client flow uses no client secret and sends the resulting user
 * access token directly to api.openai.com.
 */

import { randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "../../utils/oauth-page.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { LoginOptions, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { generatePKCE } from "./pkce.ts";

// every login registers a new client with this ID; OpenAI returns the issued client ID in the callback
const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const AGENT_NAME_HINT = "Pi";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESOURCE = "https://api.openai.com/v1";
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
const DIRECT_TOKEN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`;
// Refresh this long before the real expiry so a request never starts with a token about to expire.
const EXPIRY_MARGIN_MS = 3 * 60 * 1000;

type AuthorizationResult = {
	code: string;
	clientId: string;
};

type CallbackServer = {
	server: Server;
	result: Promise<AuthorizationResult>;
};

type TokenResponse = {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	id_token?: unknown;
	scope?: unknown;
};

function randomValue(): string {
	return randomBytes(32).toString("base64url");
}

function authorizationResultFromCallback(url: URL, expectedState: string): AuthorizationResult {
	const code = url.searchParams.get("code");
	if (!code) throw new Error("Missing authorization code");
	const state = url.searchParams.get("state");
	if (!state) throw new Error("Missing OAuth state");
	if (state !== expectedState) throw new Error("OAuth state mismatch");
	const clientId = url.searchParams.get("client_id")?.trim();
	if (!clientId) throw new Error("OpenAI OAuth registration callback did not contain an issued client ID");
	return { code, clientId };
}

function authorizationResultFromManualInput(input: string, expectedState: string): AuthorizationResult {
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new Error("Paste the full callback URL from the browser");
	}
	const expected = new URL(REDIRECT_URI);
	if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
		throw new Error(`The pasted callback URL must start with ${REDIRECT_URI}`);
	}
	const error = url.searchParams.get("error");
	if (error) throw new Error(`ChatGPT authorization failed: ${error}`);
	return authorizationResultFromCallback(url, expectedState);
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
	response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
	response.end(body);
}

function startCallbackServer(expectedState: string): Promise<CallbackServer> {
	return new Promise((resolve, reject) => {
		let resolveResult!: (result: AuthorizationResult) => void;
		let rejectResult!: (error: Error) => void;
		const result = new Promise<AuthorizationResult>((resolveAuthorization, rejectAuthorization) => {
			resolveResult = resolveAuthorization;
			rejectResult = rejectAuthorization;
		});

		const server = createServer((request, response) => {
			try {
				const url = new URL(request.url || "", REDIRECT_URI);
				if (url.pathname !== CALLBACK_PATH) {
					sendHtml(response, 404, oauthErrorHtml("Callback route not found."));
					return;
				}

				const error = url.searchParams.get("error");
				if (error) {
					sendHtml(response, 400, oauthErrorHtml("ChatGPT was not connected.", `Error: ${error}`));
					rejectResult(new Error(`ChatGPT authorization failed: ${error}`));
					return;
				}

				let authorizationResult: AuthorizationResult;
				try {
					authorizationResult = authorizationResultFromCallback(url, expectedState);
				} catch (error) {
					const message = error instanceof Error ? error.message : "Invalid callback";
					sendHtml(response, 400, oauthErrorHtml(message));
					return;
				}

				sendHtml(response, 200, oauthSuccessHtml("ChatGPT authentication completed. You can close this window."));
				resolveResult(authorizationResult);
			} catch {
				sendHtml(response, 500, oauthErrorHtml("Internal error while processing the callback."));
			}
		});

		server.once("error", reject);
		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			server.removeListener("error", reject);
			server.on("error", rejectResult);
			resolve({ server, result });
		});
	});
}

async function requestToken(body: URLSearchParams, signal: AbortSignal): Promise<TokenResponse> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded",
		},
		body,
		signal,
	});
	if (!response.ok) {
		const responseBody = await response.text().catch(() => "");
		throw new Error(`OpenAI OAuth token request failed (${response.status}): ${responseBody || response.statusText}`);
	}
	const data: unknown = await response.json();
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error("OpenAI OAuth token response must be an object");
	}
	return data as TokenResponse;
}

function requireTokenString(value: unknown, field: "access_token" | "refresh_token" | "scope"): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`OpenAI OAuth token response has invalid ${field}`);
	}
	return value;
}

function credentialFromTokenResponse(token: TokenResponse, clientId: string): OAuthCredential {
	const access = requireTokenString(token.access_token, "access_token");
	const refresh = requireTokenString(token.refresh_token, "refresh_token");
	const scope = requireTokenString(token.scope, "scope");
	if (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
		throw new Error("OpenAI OAuth token response has invalid expires_in");
	}
	const scopes = scope.trim().split(/\s+/).filter(Boolean);
	if (!scopes.includes(DIRECT_TOKEN_SCOPE)) {
		throw new Error(`OpenAI OAuth grant did not include ${DIRECT_TOKEN_SCOPE}`);
	}
	return {
		type: "oauth",
		access,
		refresh,
		expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
		clientId,
		scopes,
	};
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	clientId: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const token = await requestToken(
		new URLSearchParams({
			grant_type: "authorization_code",
			client_id: clientId,
			code,
			code_verifier: verifier,
			redirect_uri: REDIRECT_URI,
			resource: RESOURCE,
		}),
		signal,
	);
	// Pi does not use the ID token to identify the user or read profile data.
	// Keep the presence check as part of the token-response contract.
	if (typeof token.id_token !== "string" || token.id_token.trim().length === 0) {
		throw new Error("OpenAI OAuth token response did not contain an ID token");
	}
	return credentialFromTokenResponse(token, clientId);
}

async function refreshAccessToken(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const clientId = credential.clientId;
	if (typeof clientId !== "string" || clientId.trim().length === 0) {
		throw new Error("Stored OpenAI OAuth credential does not contain an issued client ID; reconnect ChatGPT");
	}
	const token = await requestToken(
		new URLSearchParams({
			grant_type: "refresh_token",
			client_id: clientId,
			refresh_token: credential.refresh,
			resource: RESOURCE,
		}),
		signal,
	);
	return credentialFromTokenResponse(token, clientId);
}

/** OpenAI identifies each installation ("agent host") by a stable URI such as `urn:uuid:<uuid>`. */
function agentHostId(deviceId: string | undefined): string {
	if (!deviceId || !UUID_PATTERN.test(deviceId)) {
		throw new Error("Sign in with ChatGPT requires a device ID (UUID) for this installation");
	}
	return `urn:uuid:${deviceId.toLowerCase()}`;
}

async function loginOpenAIChatGPT(
	interaction: ProviderAuthInteraction,
	options?: LoginOptions,
): Promise<OAuthCredential> {
	const hostId = agentHostId(options?.getDeviceId?.());
	const { verifier, challenge } = await generatePKCE();
	const state = randomValue();
	const nonce = randomValue();
	// Without this server, the browser's callback would reach whatever else holds the port (another
	// pending login or the Codex CLI), which rejects it as a state mismatch. Fail with a clear error instead.
	const callback = await startCallbackServer(state).catch((error: unknown) => {
		if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
		throw new Error(
			`Port ${CALLBACK_PORT} is in use, probably by an unfinished login in another pi session or by the Codex CLI. Cancel that login and try again.`,
		);
	});

	const authorizationUrl = new URL(AUTHORIZE_URL);
	authorizationUrl.search = new URLSearchParams({
		client_id: DYNAMIC_CLIENT_ID,
		agent_name_hint: options?.agentName ?? AGENT_NAME_HINT,
		ext_agent_host_id: hostId,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		resource: RESOURCE,
		scope: SCOPE,
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
		nonce,
	}).toString();
	interaction.notify({
		type: "auth_url",
		url: authorizationUrl.toString(),
		instructions:
			"Complete sign-in in your browser. If the callback does not complete, paste the final redirect URL here.",
	});

	const manualAbort = new AbortController();
	const manualCode = interaction
		.prompt({
			type: "manual_code",
			message: "Complete login in your browser, or paste the final redirect URL here:",
			placeholder: REDIRECT_URI,
			signal: AbortSignal.any([manualAbort.signal, interaction.signal]),
		})
		.then((input) => authorizationResultFromManualInput(input, state));

	try {
		const result = await Promise.race([callback.result, manualCode]);
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		return await exchangeAuthorizationCode(result.code, verifier, result.clientId, interaction.signal);
	} catch (error) {
		if (interaction.signal.aborted) throw new Error("Login cancelled");
		throw error;
	} finally {
		manualAbort.abort();
		callback.server.close();
		// close() only stops accepting new connections. Browsers open spare connections ahead of
		// time, and one that has not sent a request yet stays open and attached to this server.
		// A later login in the same process starts a new server with a new state, but the browser
		// may send that login's callback over the spare connection. This server would then handle
		// it and reject it with "OAuth state mismatch", and the new login would never see it.
		callback.server.closeAllConnections();
	}
}

export const openaiChatGPTOAuth: OAuthAuth = {
	name: "OpenAI (ChatGPT subscription)",
	isSubscription: true,
	loginLabel: "Sign in with ChatGPT",
	login: loginOpenAIChatGPT,
	refresh: refreshAccessToken,
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
