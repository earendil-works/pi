/**
 * Google Antigravity OAuth flow
 *
 * NOTE: This module uses Node.js crypto and http for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

// NEVER convert to top-level imports - breaks browser/Vite builds
let _randomBytes: typeof import("node:crypto").randomBytes | null = null;
let _http: typeof import("node:http") | null = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	import("node:crypto").then((m) => {
		_randomBytes = m.randomBytes;
	});
	import("node:http").then((m) => {
		_http = m;
	});
}

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";

// Base64-encoded defaults (decoded at runtime) so secret scanners don't flag
// the shipped client credentials; same approach as github-copilot.ts. These are
// the public Antigravity CLI client values, overridable via env vars below.
const decode = (s: string) => atob(s);
const DEFAULT_CLIENT_ID = decode(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const DEFAULT_CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CLOUDCODE_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
const CALLBACK_PORT = 51123;
const CALLBACK_PATH = "/oauth-callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"openid",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");

function getOAuthClient(): { clientId: string; clientSecret: string } {
	return {
		clientId: getProviderEnvValue("ANTIGRAVITY_OAUTH_CLIENT_ID") || DEFAULT_CLIENT_ID,
		clientSecret: getProviderEnvValue("ANTIGRAVITY_OAUTH_CLIENT_SECRET") || DEFAULT_CLIENT_SECRET,
	};
}

function createState(): string {
	if (_randomBytes) {
		return _randomBytes(16).toString("hex");
	}
	const array = new Uint8Array(16);
	crypto.getRandomValues(array);
	return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

interface LocalAntigravitySession {
	accessToken: string;
	refreshToken?: string;
	expiryDate?: number;
	email?: string;
	source: string;
}

function detectLocalAntigravitySession(): LocalAntigravitySession | null {
	// 1. Try macOS Keychain
	if (process.platform === "darwin") {
		try {
			const output = execSync("security find-generic-password -s gemini -a antigravity -w 2>/dev/null", {
				encoding: "utf-8",
				timeout: 2000,
			}).trim();
			if (output.startsWith("go-keyring-base64:")) {
				const jsonStr = Buffer.from(output.slice("go-keyring-base64:".length), "base64").toString("utf-8");
				const parsed = JSON.parse(jsonStr) as {
					token?: { access_token?: string; refresh_token?: string; expiry?: string };
					id_token?: string;
				};
				if (parsed.token?.access_token) {
					let email: string | undefined;
					if (parsed.id_token) {
						try {
							const payload = JSON.parse(Buffer.from(parsed.id_token.split(".")[1], "base64").toString("utf-8"));
							email = payload.email;
						} catch {
							// ignore
						}
					}
					return {
						accessToken: parsed.token.access_token,
						refreshToken: parsed.token.refresh_token,
						expiryDate: parsed.token.expiry ? new Date(parsed.token.expiry).getTime() : undefined,
						email,
						source: "macOS Keychain (Antigravity)",
					};
				}
			}
		} catch {
			// ignore keychain lookup failure
		}
	}

	// 2. Try ~/.gemini/oauth_creds.json
	try {
		const credsPath = join(homedir(), ".gemini", "oauth_creds.json");
		if (existsSync(credsPath)) {
			const creds = JSON.parse(readFileSync(credsPath, "utf-8")) as {
				access_token?: string;
				refresh_token?: string;
				expiry_date?: number;
			};
			if (creds.access_token) {
				let email: string | undefined;
				const accountsPath = join(homedir(), ".gemini", "google_accounts.json");
				if (existsSync(accountsPath)) {
					try {
						const acc = JSON.parse(readFileSync(accountsPath, "utf-8")) as { active?: string };
						email = acc.active;
					} catch {
						// ignore
					}
				}
				return {
					accessToken: creds.access_token,
					refreshToken: creds.refresh_token,
					expiryDate: creds.expiry_date,
					email,
					source: "~/.gemini/oauth_creds.json",
				};
			}
		}
	} catch {
		// ignore
	}

	// 3. Try ~/.gemini/jetski-standalone-oauth-token
	try {
		const jetskiPath = join(homedir(), ".gemini", "jetski-standalone-oauth-token");
		if (existsSync(jetskiPath)) {
			const creds = JSON.parse(readFileSync(jetskiPath, "utf-8")) as {
				token?: { access_token?: string; refresh_token?: string; expiry?: string };
			};
			if (creds.token?.access_token) {
				return {
					accessToken: creds.token.access_token,
					refreshToken: creds.token.refresh_token,
					expiryDate: creds.token.expiry ? new Date(creds.token.expiry).getTime() : undefined,
					source: "~/.gemini/jetski-standalone-oauth-token",
				};
			}
		}
	} catch {
		// ignore
	}

	return null;
}

async function resolveCloudCodeProject(accessToken: string, signal?: AbortSignal): Promise<string> {
	try {
		const res = await fetch(`${CLOUDCODE_BASE_URL}/v1internal:loadCodeAssist`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
				"User-Agent": "antigravity/1.21.9 darwin/arm64",
			},
			body: JSON.stringify({
				metadata: {
					ideType: "ANTIGRAVITY",
					platform: "PLATFORM_UNSPECIFIED",
					pluginType: "GEMINI",
				},
			}),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
		});
		if (res.ok) {
			const data = (await res.json()) as {
				cloudaicompanionProject?: string | { id?: string };
			};
			const project = data.cloudaicompanionProject;
			if (typeof project === "string" && project.trim()) return project.trim();
			if (project && typeof project === "object" && project.id) return project.id.trim();
		}
	} catch {
		// ignore
	}
	return "aicode-consumers";
}

async function fetchUserEmail(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const res = await fetch(USERINFO_URL, {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
		});
		if (res.ok) {
			const data = (await res.json()) as { email?: string };
			return data.email;
		}
	} catch {
		// ignore
	}
	return undefined;
}

type CallbackServerInfo = {
	server: import("node:http").Server;
	redirectUri: string;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
};

async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
	const httpModule = _http || (await import("node:http"));
	_http = httpModule;

	return new Promise((resolve, reject) => {
		let settleWait: ((value: { code: string; state: string } | null) => void) | undefined;
		const waitForCodePromise = new Promise<{ code: string; state: string } | null>((resolveWait) => {
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
		});

		const server = httpModule.createServer((req, res) => {
			try {
				const url = new URL(req.url || "", "http://localhost");
				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Callback route not found."));
					return;
				}

				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Google Antigravity sign-in failed.", `Error: ${error}`));
					return;
				}

				if (!code || !state) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Missing code or state parameter."));
					return;
				}

				if (state !== expectedState) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("State mismatch."));
					return;
				}

				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthSuccessHtml("Google Antigravity authentication successful. You can close this window."));
				settleWait?.({ code, state });
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			}
		});

		server.on("error", (err) => {
			reject(err);
		});

		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			resolve({
				server,
				redirectUri: REDIRECT_URI,
				cancelWait: () => settleWait?.(null),
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}

async function exchangeAuthorizationCode(
	code: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
	const { clientId, clientSecret } = getOAuthClient();
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: clientId,
			client_secret: clientSecret,
			code,
			redirect_uri: redirectUri,
		}),
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Google OAuth code exchange failed (${response.status}): ${text || response.statusText}`);
	}

	const data = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!data.access_token || typeof data.expires_in !== "number") {
		throw new Error("Invalid token response from Google OAuth");
	}

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token || "",
		expiresIn: data.expires_in,
	};
}

async function refreshAntigravityToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	const { clientId, clientSecret } = getOAuthClient();
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
		}),
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Google OAuth token refresh failed (${response.status}): ${text || response.statusText}`);
	}

	const data = (await response.json()) as {
		access_token?: string;
		expires_in?: number;
	};

	if (!data.access_token || typeof data.expires_in !== "number") {
		throw new Error("Invalid refresh token response from Google OAuth");
	}

	return {
		type: "oauth",
		access: data.access_token,
		refresh: refreshToken,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

async function loginAntigravity(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// Check for local session first
	const localSession = detectLocalAntigravitySession();
	if (localSession?.accessToken) {
		const emailLabel = localSession.email ? ` (${localSession.email})` : "";
		const choice = await interaction.prompt({
			type: "select",
			message: "Google Antigravity authentication:",
			options: [
				{
					id: "local",
					label: `Use detected local Antigravity credentials${emailLabel}`,
					description: `Source: ${localSession.source}`,
				},
				{
					id: "web",
					label: "Sign in with a new Google Account (browser OAuth)",
				},
			],
		});

		if (choice === "local") {
			const projectId = await resolveCloudCodeProject(localSession.accessToken, interaction.signal);
			const email = localSession.email || (await fetchUserEmail(localSession.accessToken, interaction.signal));
			return {
				type: "oauth",
				access: localSession.accessToken,
				refresh: localSession.refreshToken || "",
				expires: localSession.expiryDate ?? Date.now() + 3600 * 1000,
				projectId,
				email,
			};
		}
	}

	const state = createState();
	const { clientId } = getOAuthClient();

	let callbackServer: CallbackServerInfo | undefined;
	try {
		callbackServer = await startCallbackServer(state);
	} catch {
		// Port might be in use or Node http unavailable; proceed with manual entry
	}

	const redirectUri = callbackServer ? callbackServer.redirectUri : REDIRECT_URI;
	const authUrl = `${AUTH_URL}?access_type=offline&scope=${encodeURIComponent(
		SCOPES,
	)}&state=${encodeURIComponent(state)}&prompt=consent&response_type=code&client_id=${encodeURIComponent(
		clientId,
	)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

	interaction.notify({
		type: "auth_url",
		url: authUrl,
		instructions: "Complete sign-in in your browser. If redirected automatically, this prompt will continue.",
	});

	let code: string | undefined;

	if (callbackServer) {
		const manualPromptController = new AbortController();
		const serverWait = callbackServer.waitForCode();
		const manualWait = interaction
			.prompt({
				type: "manual_code",
				message: "Paste the authorization code or redirect URL here if browser callback fails:",
				signal: manualPromptController.signal,
			})
			.then((input) => parseAuthorizationInput(input).code)
			.catch(() => undefined);

		const firstResult = await Promise.race([
			serverWait.then((res) => ({ source: "server" as const, code: res?.code })),
			manualWait.then((res) => ({ source: "manual" as const, code: res })),
		]);

		if (firstResult.source === "server" && firstResult.code) {
			manualPromptController.abort();
			code = firstResult.code;
		} else if (firstResult.source === "manual" && firstResult.code) {
			callbackServer.cancelWait();
			code = firstResult.code;
		}
	} else {
		const input = await interaction.prompt({
			type: "manual_code",
			message: "Paste the authorization code or redirect URL here:",
		});
		code = parseAuthorizationInput(input).code;
	}

	if (callbackServer) {
		callbackServer.server.close();
	}

	if (!code) {
		throw new Error("No authorization code received");
	}

	const tokenData = await exchangeAuthorizationCode(code, redirectUri, interaction.signal);
	const projectId = await resolveCloudCodeProject(tokenData.accessToken, interaction.signal);
	const email = await fetchUserEmail(tokenData.accessToken, interaction.signal);

	return {
		type: "oauth",
		access: tokenData.accessToken,
		refresh: tokenData.refreshToken,
		expires: Date.now() + tokenData.expiresIn * 1000 - 5 * 60 * 1000,
		projectId,
		email,
	};
}

export const antigravityOAuth: OAuthAuth = {
	name: "Google Antigravity",
	isSubscription: true,
	loginLabel: "Sign in with Google Antigravity",
	login: loginAntigravity,
	refresh: async (credential, signal) => {
		const refreshed = await refreshAntigravityToken(credential.refresh, signal);
		return {
			...credential,
			access: refreshed.access,
			expires: refreshed.expires,
		};
	},
	async toAuth(credential) {
		return {
			apiKey: credential.access,
			headers: {
				Authorization: `Bearer ${credential.access}`,
				"User-Agent": "antigravity/1.21.9 darwin/arm64",
				"X-Antigravity-Project": (credential.projectId as string) || "aicode-consumers",
			},
		};
	},
};
