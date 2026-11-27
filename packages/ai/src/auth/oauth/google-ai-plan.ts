/**
 * Google AI Ultra plan sign-in: Google OAuth for a `Desktop app` client with a loopback redirect, PKCE, and
 * DPoP (RFC 9449). Google binds the refresh token to a key pair created on this machine; every call to the
 * token endpoint carries a proof signed with that key. Model calls use the access token as a plain Bearer
 * token, without DPoP.
 *
 * Prototype: the private key is stored in the credential (auth.json) instead of the OS credential store.
 *
 * NOTE: This module uses node:http through the callback server. It is only reachable through the lazily
 * loaded OAuth flow modules, never from browser-facing entry points.
 */

import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

/**
 * An app's own Google `Desktop app` OAuth client, approved by Google for the AI Ultra plan. Google approves each
 * app's client separately and does not allow one app to use another's, so pi-ai ships none.
 */
export interface GoogleAiPlanClient {
	clientId: string;
	clientSecret: string;
}

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const QUOTA_SCOPE = "https://www.googleapis.com/auth/generative-language.peruserquota";
const SCOPES = `openid email profile ${QUOTA_SCOPE}`;
const CALLBACK_PATH = "/oauth2callback";
// Long enough to finish a plan upgrade checkout in the browser.
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
const SIGN_IN_AGAIN = "Your Google AI Ultra plan sign-in is no longer valid. Run /login to sign in again.";

/**
 * P-256 private key as stored in the credential. The DPoP header gets only the public fields `kty`, `crv`, `x`, `y`;
 * WebCrypto also exports `ext` and `key_ops`, which Google rejects.
 */
interface EcPrivateJwk {
	kty: string;
	crv: string;
	x: string;
	y: string;
	d: string;
}

/** The OAuth credential with the fields this flow stores next to `access`, `refresh` and `expires`. */
type GoogleAiPlanCredential = OAuthCredential & {
	dpopKey: EcPrivateJwk;
	/** Latest `DPoP-Nonce` from a refresh response; saves a `use_dpop_nonce` round trip. */
	dpopNonce?: string;
};

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	id_token?: string;
	error?: string;
	error_description?: string;
}

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
	return Buffer.from(new Uint8Array(bytes)).toString("base64url");
}

function randomToken(byteLength: number): string {
	return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function createDpopKey(): Promise<EcPrivateJwk> {
	const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
	const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", privateKey);
	if (!kty || !crv || !x || !y || !d) throw new Error("Failed to export DPoP key");
	return { kty, crv, x, y, d };
}

/**
 * Sign a DPoP proof for the token endpoint. WebCrypto ECDSA signatures are raw R||S (64 bytes), the format
 * Google requires; DER signatures are rejected.
 */
async function createDpopProof(
	key: EcPrivateJwk,
	claims: { jti: string; nonce?: string; iat?: number },
): Promise<string> {
	const { kty, crv, x, y } = key;
	const header = { typ: "dpop+jwt", alg: "ES256", jwk: { kty, crv, x, y } };
	const { iat = Math.floor(Date.now() / 1000), ...rest } = claims;
	const payload = { ...rest, htm: "POST", htu: TOKEN_URL, iat };
	const input = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(encoder.encode(JSON.stringify(payload)))}`;
	const signingKey = await crypto.subtle.importKey("jwk", key, { name: "ECDSA", namedCurve: "P-256" }, false, [
		"sign",
	]);
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, encoder.encode(input));
	return `${input}.${base64url(signature)}`;
}

async function postToken(
	client: GoogleAiPlanClient,
	params: Record<string, string>,
	dpop: string,
	signal: AbortSignal,
): Promise<{ status: number; body: TokenResponse; nonce: string | undefined; serverTime: number | undefined }> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", DPoP: dpop },
		body: new URLSearchParams({ ...params, client_id: client.clientId, client_secret: client.clientSecret }),
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});
	const text = await response.text();
	let body: TokenResponse;
	try {
		body = JSON.parse(text) as TokenResponse;
	} catch {
		body = { error: `HTTP ${response.status}`, error_description: text };
	}
	// Google's clock in Unix seconds, from the `Date` header; used when our clock is off.
	const serverTime = Date.parse(response.headers.get("date") ?? "");
	return {
		status: response.status,
		body,
		nonce: response.headers.get("dpop-nonce") ?? undefined,
		serverTime: Number.isNaN(serverTime) ? undefined : Math.floor(serverTime / 1000),
	};
}

function describeTokenError(prefix: string, status: number, body: TokenResponse): Error {
	return new Error(`${prefix}: ${status} ${body.error ?? ""} ${body.error_description ?? ""}`.trim());
}

/** Check the ID token's issuer, audience, expiry and nonce, as Google's docs require. */
function checkIdToken(idToken: string | undefined, nonce: string, clientId: string): void {
	if (!idToken) throw new Error("Google sign-in returned no ID token");
	// The token comes straight from Google's token endpoint over TLS, so the claims are read without
	// verifying the signature (OpenID Connect Core 3.1.3.7).
	const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
		iss?: string;
		aud?: string;
		exp?: number;
		nonce?: string;
	};
	const issuerOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
	const notExpired = (claims.exp ?? 0) * 1000 > Date.now() - 60_000;
	if (!issuerOk || claims.aud !== clientId || claims.nonce !== nonce || !notExpired) {
		throw new Error("Google sign-in returned an ID token that failed validation");
	}
}

async function login(client: GoogleAiPlanClient, interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const state = randomToken(32);
	const nonce = randomToken(32);
	const dpopKey = await createDpopKey();
	const finish = (code: string): Promise<OAuthCredential> =>
		finishSignIn(client, code, { verifier, nonce, dpopKey, redirectUri: callback.redirectUri }, interaction);

	// Loopback only, on a free port: Desktop app clients accept any port, and 0.0.0.0 is not allowed.
	const callback = await startOAuthCallbackServer({
		providerName: "Google",
		host: "127.0.0.1",
		port: 0,
		path: CALLBACK_PATH,
		state,
		// Finishing inside the callback lets the browser page show a failed exchange or check instead of "Signed in".
		complete: finish,
		signal: interaction.signal,
		timeoutMs: CALLBACK_TIMEOUT_MS,
	});

	try {
		const params = new URLSearchParams({
			client_id: client.clientId,
			redirect_uri: callback.redirectUri,
			response_type: "code",
			scope: SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
			nonce,
		});
		interaction.notify({ type: "auth_url", url: `${AUTHORIZE_URL}?${params.toString()}` });

		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message:
				"Continue with Google in your browser. If the browser is on another machine, paste the final URL from its address bar here:",
			placeholder: callback.redirectUri,
		});
		if (result.type === "callback") return result.value;

		// The URL the browser was sent to after consent (Google's remote-host "Option B"); a matching `state` proves
		// it belongs to this sign-in.
		const url = new URL(result.input.trim());
		if (url.searchParams.get("state") !== state) throw new Error("Sign-in state mismatch");
		const error = url.searchParams.get("error");
		if (error === "access_denied") throw new Error("Sign-in was canceled");
		if (error) throw new Error(`Google sign-in failed: ${error}`);
		const code = url.searchParams.get("code");
		if (!code) throw new Error("Missing authorization code");
		return await finish(code);
	} finally {
		callback.close();
	}
}

/** Exchange the authorization code for tokens, check the result, and build the credential. */
async function finishSignIn(
	client: GoogleAiPlanClient,
	code: string,
	session: { verifier: string; nonce: string; dpopKey: EcPrivateJwk; redirectUri: string },
	interaction: ProviderAuthInteraction,
): Promise<OAuthCredential> {
	interaction.notify({ type: "progress", message: "Finishing sign-in..." });
	// The code-exchange proof uses the code's hash as jti; a random jti fails and burns the single-use code.
	const jti = base64url(await crypto.subtle.digest("SHA-256", encoder.encode(code)));
	// The exchange also returns a `DPoP-Nonce`, but refreshes use a separate nonce, so it is not kept.
	const { status, body } = await postToken(
		client,
		{
			grant_type: "authorization_code",
			code,
			code_verifier: session.verifier,
			redirect_uri: session.redirectUri,
		},
		await createDpopProof(session.dpopKey, { jti }),
		interaction.signal,
	);
	if (status !== 200 || !body.access_token || !body.refresh_token) {
		throw describeTokenError("Google sign-in failed", status, body);
	}
	if (!(body.scope ?? "").split(" ").includes(QUOTA_SCOPE)) {
		throw new Error("Google did not grant access to the Google AI Ultra plan. Try signing in again.");
	}
	checkIdToken(body.id_token, session.nonce, client.clientId);
	const credential: GoogleAiPlanCredential = {
		type: "oauth",
		access: body.access_token,
		refresh: body.refresh_token,
		expires: accessExpiry(body),
		dpopKey: session.dpopKey,
	};
	return credential;
}

async function refresh(
	client: GoogleAiPlanClient,
	credential: OAuthCredential,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const dpopKey = readDpopKey(credential);
	const proof: { nonce?: string; iat?: number } = {
		...(typeof credential.dpopNonce === "string" && { nonce: credential.dpopNonce }),
	};
	let result = await postRefresh(client, credential.refresh, dpopKey, proof, signal);
	// Two rejections are fixed by retrying once each, in either order. A stale nonce (and none at all after sign-in)
	// gets `use_dpop_nonce` with a fresh nonce. A clock more than 10 s ahead of Google's gets `invalid_dpop_proof`;
	// the retry takes the proof time from the response's `Date` header.
	for (let retry = 0; retry < 2; retry++) {
		if (result.body.error === "use_dpop_nonce" && result.nonce && proof.nonce !== result.nonce) {
			proof.nonce = result.nonce;
		} else if (result.body.error === "invalid_dpop_proof" && proof.iat === undefined && result.serverTime) {
			proof.iat = result.serverTime;
		} else {
			break;
		}
		result = await postRefresh(client, credential.refresh, dpopKey, proof, signal);
	}
	const { status, body, nonce } = result;
	if (status !== 200 || !body.access_token) {
		// Google's docs name these two as final: the grant expired (7 days) or was revoked, or the client is no longer
		// allowed for this token.
		if (body.error === "invalid_grant" || body.error === "unauthorized_client") throw new Error(SIGN_IN_AGAIN);
		throw describeTokenError("Google token refresh failed", status, body);
	}
	// Keep Google's newest nonce, else the one this request just used successfully.
	const dpopNonce = nonce ?? proof.nonce;
	return { ...credential, access: body.access_token, expires: accessExpiry(body), ...(dpopNonce && { dpopNonce }) };
}

/** The DPoP key from a stored credential. auth.json is read from disk, so its shape is checked here. */
function readDpopKey(credential: OAuthCredential): EcPrivateJwk {
	const key = credential.dpopKey as Partial<Record<keyof EcPrivateJwk, unknown>> | undefined;
	const fields = [key?.kty, key?.crv, key?.x, key?.y, key?.d];
	if (!fields.every((field) => typeof field === "string")) throw new Error(SIGN_IN_AGAIN);
	return key as EcPrivateJwk;
}

async function postRefresh(
	client: GoogleAiPlanClient,
	refreshToken: string,
	dpopKey: EcPrivateJwk,
	claims: { nonce?: string; iat?: number },
	signal: AbortSignal,
) {
	const proof = await createDpopProof(dpopKey, { jti: randomToken(24), ...claims });
	return postToken(client, { grant_type: "refresh_token", refresh_token: refreshToken }, proof, signal);
}

/**
 * When the access token really expires. pi refreshes 5 minutes before that (`resolve.ts`), which is what Google's
 * docs ask for.
 */
function accessExpiry(body: TokenResponse): number {
	return Date.now() + (body.expires_in ?? 3599) * 1000;
}

/** The Google AI Ultra plan sign-in for the app's own Google client. */
export function createGoogleAiPlanOAuth(client: GoogleAiPlanClient): OAuthAuth {
	return {
		name: "Google AI Ultra plan",
		isSubscription: true,
		loginLabel: "Sign in with Google (AI Ultra)",
		login: (interaction) => login(client, interaction),
		refresh: (credential, signal) => refresh(client, credential, signal),
		async toAuth(credential) {
			return { headers: { Authorization: `Bearer ${credential.access}` } };
		},
	};
}
