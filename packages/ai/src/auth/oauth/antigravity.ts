// Adapted from pi-antigravity (MIT), Copyright (c) 2026 Rahul Arya.
// See ../../api/antigravity/LICENSE.
import { fetch as oauthFetch } from "undici";
import { defaultProjectId, loadCodeAssist } from "../../api/antigravity/client.ts";
import { safeError } from "../../api/antigravity/security.ts";
import { antigravityEnv, isRecord } from "../../api/antigravity/util.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = ["aicode", "cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs"].map(
	(scope) => `https://www.googleapis.com/auth/${scope}`,
);
// Public desktop OAuth client, not a private application credential.
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";

async function exchange(
	parameters: Record<string, string>,
	signal: AbortSignal,
): Promise<{ access: string; refresh?: string; expires: number }> {
	signal.throwIfAborted();
	// Keep Google OAuth decompression in Undici (upstream pi-antigravity #69),
	// retaining its shared dispatcher without replacing the host\'s global fetch.
	const response = await oauthFetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: antigravityEnv("CLIENT_ID") || CLIENT_ID,
			client_secret: antigravityEnv("CLIENT_SECRET") || CLIENT_SECRET,
			...parameters,
		}).toString(),
		signal,
	});
	if (!response.ok)
		throw new Error(`Antigravity OAuth (${response.status}): ${safeError(await response.text()).slice(0, 300)}`);
	const data: unknown = await response.json();
	if (
		!isRecord(data) ||
		typeof data.access_token !== "string" ||
		!data.access_token ||
		typeof data.expires_in !== "number" ||
		!Number.isFinite(data.expires_in) ||
		data.expires_in <= 0
	)
		throw new Error("Invalid Antigravity OAuth response");
	return {
		access: data.access_token,
		refresh: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
		expires: Date.now() + Math.max(0, data.expires_in - 300) * 1000,
	};
}

export function parseAntigravityCallback(input: string, expectedState: string): string {
	const url = new URL(input.trim());
	if (url.searchParams.get("state") !== expectedState) throw new Error("Antigravity OAuth state mismatch");
	const code = url.searchParams.get("code");
	if (!code || url.searchParams.has("error")) throw new Error("Antigravity OAuth callback has no authorization code");
	return code;
}

async function login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { signal } = interaction;
	signal.throwIfAborted();
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	const callback = await startOAuthCallbackServer({
		providerName: "Antigravity",
		host: "127.0.0.1",
		redirectHost: "localhost",
		port: 51121,
		path: "/oauth-callback",
		state,
		complete: async (code) => code,
		signal,
		timeoutMs: 300_000,
	});
	try {
		const query = new URLSearchParams({
			client_id: antigravityEnv("CLIENT_ID") || CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
			access_type: "offline",
			prompt: "consent",
		});
		interaction.notify({
			type: "auth_url",
			url: `https://accounts.google.com/o/oauth2/v2/auth?${query}`,
			instructions:
				"Sign in with Google. If the browser cannot reach this machine, paste the complete callback URL.",
		});
		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Paste the complete Antigravity callback URL",
			placeholder: `${REDIRECT_URI}?state=…&code=…`,
		});
		signal.throwIfAborted();
		const code = result.type === "callback" ? result.value : parseAntigravityCallback(result.input, state);
		const tokens = await exchange(
			{ code, grant_type: "authorization_code", redirect_uri: REDIRECT_URI, code_verifier: verifier },
			signal,
		);
		if (!tokens.refresh) throw new Error("Antigravity did not grant offline access; sign in again");
		let email: string | undefined;
		try {
			const response = await oauthFetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
				headers: { Authorization: `Bearer ${tokens.access}` },
				signal,
			});
			if (response.ok) {
				const user: unknown = await response.json();
				if (isRecord(user) && typeof user.email === "string") email = user.email;
			}
		} catch {
			signal.throwIfAborted();
		}
		const projectId = (await loadCodeAssist(tokens.access, { signal })) || (await defaultProjectId(email));
		return { type: "oauth", ...tokens, refresh: tokens.refresh, projectId, email };
	} finally {
		callback.close();
	}
}

export const antigravityOAuth: OAuthAuth = {
	name: "Antigravity (Google account)",
	isSubscription: true,
	login,
	async refresh(credential, signal) {
		const tokens = await exchange({ refresh_token: credential.refresh, grant_type: "refresh_token" }, signal);
		const projectId =
			typeof credential.projectId === "string" && credential.projectId
				? credential.projectId
				: (await loadCodeAssist(tokens.access, { signal })) ||
					(await defaultProjectId(typeof credential.email === "string" ? credential.email : undefined));
		return { ...credential, ...tokens, refresh: tokens.refresh || credential.refresh, projectId };
	},
	async toAuth(credential) {
		const projectId =
			typeof credential.projectId === "string" && credential.projectId
				? credential.projectId
				: await defaultProjectId(typeof credential.email === "string" ? credential.email : undefined);
		return { apiKey: JSON.stringify({ token: credential.access, projectId }) };
	},
};
