import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { BindingType, SignInResult, UserProfile } from "./client.ts";

/** Persisted MatwingsVenus auth state. */
export interface StoredAuth {
	access_token: string;
	refresh_token: string;
	/** Access-token expiry as epoch milliseconds. */
	expires_at: number;
	user: UserProfile;
	binding_required?: boolean;
	binding_type?: BindingType | null;
}

/** Build a sign-in result into the persisted shape (does not write). */
export function toStoredAuth(result: SignInResult): StoredAuth {
	return {
		access_token: result.access_token,
		refresh_token: result.refresh_token,
		expires_at: Date.parse(result.expires_at) || 0,
		user: result.user,
		binding_required: result.binding_required,
		binding_type: result.binding_type,
	};
}

/** File storing the MatwingsVenus tokens (kept separate from provider auth.json). */
export function getAuthFilePath(): string {
	return join(getAgentDir(), "matwings-auth.json");
}

/** Load persisted auth, or null if none. */
export async function loadTokens(): Promise<StoredAuth | null> {
	try {
		const data = await readFile(getAuthFilePath(), "utf8");
		return JSON.parse(data) as StoredAuth;
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === "ENOENT") return null;
		throw e;
	}
}

/** Persist auth atomically with 0o600 permissions. */
export async function saveTokens(auth: StoredAuth): Promise<void> {
	const file = getAuthFilePath();
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	await writeFile(tmp, JSON.stringify(auth, null, 2), { mode: 0o600 });
	await chmod(tmp, 0o600);
	await rename(tmp, file);
}

/** Remove persisted auth (no-op if absent). */
export async function clearTokens(): Promise<void> {
	try {
		await unlink(getAuthFilePath());
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code !== "ENOENT") throw e;
	}
}
