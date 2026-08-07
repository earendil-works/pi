import { REFRESH_BUFFER_MS } from "./config.ts";
import { renewToken, signOut, type BindingType, type SignInResult, type SystemFeature } from "./client.ts";
import { clearTokens, loadTokens, saveTokens, toStoredAuth, type StoredAuth } from "./storage.ts";

/** Whether an access token is within the refresh buffer of expiry (or already expired). */
export function needsRefresh(expiresAtMs: number, now: number = Date.now()): boolean {
	return expiresAtMs - now <= REFRESH_BUFFER_MS;
}

/** Persist a successful sign-in response and return the stored auth. */
export async function applySignIn(result: SignInResult): Promise<StoredAuth> {
	const stored = toStoredAuth(result);
	await saveTokens(stored);
	return stored;
}

/**
 * Return valid stored auth, refreshing with the refresh token when possible.
 * Returns null when the user must (re-)login. Pure logic — performs no UI.
 */
export async function ensureValidAuth(): Promise<StoredAuth | null> {
	const stored = await loadTokens();
	if (!stored) return null;
	if (!needsRefresh(stored.expires_at)) return stored;
	try {
		const refreshed = await renewToken(stored.refresh_token);
		return await applySignIn(refreshed);
	} catch {
		return null;
	}
}

/** Quick check: is there any persisted auth at all (no network)? */
export async function hasStoredAuth(): Promise<boolean> {
	return (await loadTokens()) !== null;
}

export interface BindingRequirement {
	type: BindingType;
	mandatory: boolean;
}

/**
 * Decide whether binding is required after sign-in, using the login hint and
 * the backend's force flags. Returns null when no binding is required.
 */
export function computeBindingRequirement(
	signIn: SignInResult,
	feature?: SystemFeature,
): BindingRequirement | null {
	if (!signIn.binding_required || !signIn.binding_type) return null;
	const forcePhone = feature?.force_phone_binding ?? false;
	const forceEmail = feature?.force_email_binding ?? false;
	let mandatory = false;
	if (signIn.binding_type === "phone") mandatory = forcePhone;
	else if (signIn.binding_type === "email") mandatory = forceEmail;
	else mandatory = forcePhone || forceEmail;
	return { type: signIn.binding_type, mandatory };
}

/** Log out: best-effort sign-out of the stored session, then clear local tokens. */
export async function logout(): Promise<void> {
	const stored = await loadTokens();
	if (stored) await signOut(stored.access_token);
	await clearTokens();
}
