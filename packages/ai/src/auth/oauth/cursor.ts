/**
 * Cursor Pro OAuth flow
 *
 * Supports:
 * 1. Detecting local Cursor IDE credentials from state.vscdb
 * 2. Browser PKCE authorization flow against cursor.com / api2.cursor.sh
 * 3. Token refresh against https://api2.cursor.sh/oauth/token
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { sleep } from "../../utils/sleep.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { generatePKCE } from "./pkce.ts";

const CLIENT_ID = getProviderEnvValue("CURSOR_OAUTH_CLIENT_ID") || "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const LOGIN_URL = "https://cursor.com/loginDeepControl";
const POLL_URL = "https://api2.cursor.sh/auth/poll";
const TOKEN_URL = "https://api2.cursor.sh/oauth/token";
const STRIPE_PROFILE_URL = "https://api2.cursor.sh/auth/stripe_profile";

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

interface LocalCursorSession {
	accessToken: string;
	refreshToken?: string;
	email?: string;
	membershipType?: string;
	source: string;
}

function getCursorStateDbPath(): string | null {
	if (process.platform === "darwin") {
		const p = join(homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
		if (existsSync(p)) return p;
	} else if (process.platform === "win32") {
		const appData = process.env.APPDATA;
		if (appData) {
			const p = join(appData, "Cursor/User/globalStorage/state.vscdb");
			if (existsSync(p)) return p;
		}
	} else {
		const p = join(homedir(), ".config/Cursor/User/globalStorage/state.vscdb");
		if (existsSync(p)) return p;
	}
	return null;
}

async function detectLocalCursorSession(): Promise<LocalCursorSession | null> {
	const dbPath = getCursorStateDbPath();
	if (!dbPath) return null;

	try {
		// Try using Node 22+ built-in node:sqlite DatabaseSync
		const sqliteModule = await import("node:sqlite").catch(() => null);
		if (sqliteModule?.DatabaseSync) {
			const db = new sqliteModule.DatabaseSync(dbPath, { readOnly: true });
			try {
				const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = ?");
				const tokenRow = stmt.get("cursorAuth/accessToken") as { value?: string } | undefined;
				const refreshRow = stmt.get("cursorAuth/refreshToken") as { value?: string } | undefined;
				const emailRow = stmt.get("cursorAuth/cachedEmail") as { value?: string } | undefined;
				const membershipRow = stmt.get("cursorAuth/stripeMembershipType") as { value?: string } | undefined;

				if (tokenRow?.value) {
					return {
						accessToken: tokenRow.value,
						refreshToken: refreshRow?.value,
						email: emailRow?.value,
						membershipType: membershipRow?.value,
						source: dbPath,
					};
				}
			} finally {
				db.close();
			}
		}
	} catch {
		// Ignore sqlite read failure and fallback to browser login
	}

	return null;
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".");
		if (parts.length < 2) return null;
		return JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function verifyCursorMembership(accessToken: string): Promise<string | undefined> {
	try {
		const res = await fetch(STRIPE_PROFILE_URL, {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(5000),
		});
		if (res.ok) {
			const text = await res.text();
			return text.trim();
		}
	} catch {
		// ignore
	}
	return undefined;
}

async function pollForCursorAuth(
	uuid: string,
	verifier: string,
	signal: AbortSignal,
): Promise<{ accessToken: string; refreshToken: string; email?: string; membershipType?: string }> {
	const startTime = Date.now();

	while (Date.now() - startTime < POLL_TIMEOUT_MS) {
		signal.throwIfAborted();

		try {
			const res = await fetch(
				`${POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
				{
					headers: {
						"User-Agent": "Cursor/0.46.0",
					},
					signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
				},
			);

			if (res.status === 200) {
				const data = (await res.json()) as {
					accessToken?: string;
					refreshToken?: string;
					access_token?: string;
					refresh_token?: string;
					email?: string;
					membershipType?: string;
				};

				const accessToken = data.accessToken || data.access_token;
				const refreshToken = data.refreshToken || data.refresh_token;

				if (accessToken) {
					return {
						accessToken,
						refreshToken: refreshToken || "",
						email: data.email,
						membershipType: data.membershipType,
					};
				}
			} else if (res.status !== 404) {
				const text = await res.text().catch(() => "");
				if (res.status === 403 || res.status === 401) {
					throw new Error(`Cursor authorization rejected (${res.status}): ${text}`);
				}
			}
		} catch (err: unknown) {
			if (signal.aborted) throw new Error("Login cancelled");
			if (err instanceof Error && err.message.includes("rejected")) throw err;
		}

		await sleep(POLL_INTERVAL_MS, signal);
	}

	throw new Error("Cursor login timed out waiting for browser completion");
}

async function refreshCursorToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		}),
		signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Cursor token refresh failed (${response.status}): ${text || response.statusText}`);
	}

	const data = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!data.access_token) {
		throw new Error("Invalid token refresh response from Cursor");
	}

	const payload = parseJwtPayload(data.access_token);
	const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : Date.now() + 30 * 24 * 3600 * 1000;

	return {
		type: "oauth",
		access: data.access_token,
		refresh: data.refresh_token || refreshToken,
		expires: exp - 5 * 60 * 1000,
	};
}

async function loginCursor(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// Check for existing local Cursor IDE session
	const localSession = await detectLocalCursorSession();
	if (localSession?.accessToken) {
		const emailDesc = localSession.email ? ` (${localSession.email})` : "";
		const planDesc = localSession.membershipType ? ` · Plan: ${localSession.membershipType}` : " · Pro";

		const choice = await interaction.prompt({
			type: "select",
			message: "Cursor Pro authentication:",
			options: [
				{
					id: "local",
					label: `Use detected Cursor credentials${emailDesc}${planDesc}`,
					description: `Source: ${localSession.source}`,
				},
				{
					id: "browser",
					label: "Sign in with Cursor account in browser",
				},
			],
		});

		if (choice === "local") {
			const payload = parseJwtPayload(localSession.accessToken);
			const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : Date.now() + 30 * 24 * 3600 * 1000;
			return {
				type: "oauth",
				access: localSession.accessToken,
				refresh: localSession.refreshToken || "",
				expires: exp - 5 * 60 * 1000,
				email: localSession.email,
				membershipType: localSession.membershipType || "pro",
			};
		}
	}

	// Browser PKCE flow
	const { verifier, challenge } = await generatePKCE();
	const uuid = crypto.randomUUID();
	const loginUrl = `${LOGIN_URL}?challenge=${encodeURIComponent(challenge)}&uuid=${encodeURIComponent(
		uuid,
	)}&mode=login&supportsSelectedTeamLogin=true`;

	interaction.notify({
		type: "auth_url",
		url: loginUrl,
		instructions: "Complete sign-in in your browser. This prompt will continue automatically.",
	});

	const result = await pollForCursorAuth(uuid, verifier, interaction.signal);
	let membershipType = result.membershipType;
	if (!membershipType) {
		membershipType = await verifyCursorMembership(result.accessToken);
	}
	const payload = parseJwtPayload(result.accessToken);
	const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : Date.now() + 30 * 24 * 3600 * 1000;

	return {
		type: "oauth",
		access: result.accessToken,
		refresh: result.refreshToken,
		expires: exp - 5 * 60 * 1000,
		email: result.email,
		membershipType: membershipType || "pro",
	};
}

export const cursorOAuth: OAuthAuth = {
	name: "Cursor Pro",
	isSubscription: true,
	loginLabel: "Sign in with Cursor Pro",
	login: loginCursor,
	refresh: async (credential, signal) => {
		const refreshed = await refreshCursorToken(credential.refresh, signal);
		return {
			...credential,
			access: refreshed.access,
			refresh: refreshed.refresh,
			expires: refreshed.expires,
		};
	},
	async toAuth(credential) {
		return {
			apiKey: credential.access,
			headers: {
				Authorization: `Bearer ${credential.access}`,
				"User-Agent": "Cursor/0.46.0",
			},
		};
	},
};
