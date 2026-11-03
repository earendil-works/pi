// Secrets of the app kit (slice 13 §2): tokens from `crypto.randomBytes`, kept only as their SHA-256 hashes and
// compared in constant time, and secret files (the cookie key, the owner token file) created with mode 0600 in one
// step, so no other OS user and no half-written file ever reads them.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { link, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A fresh random token of `bytes` bytes, base64url. */
export function newToken(bytes = 32): string {
	return randomBytes(bytes).toString("base64url");
}

/** The hash a token is kept as (SHA-256, hex): what leaks from a store is no credential. */
export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Whether `token` hashes to `hash`, compared in constant time. */
export function matchesHash(token: string, hash: string): boolean {
	const given = Buffer.from(hashToken(token), "hex");
	const kept = Buffer.from(hash, "hex");
	return given.length === kept.length && timingSafeEqual(given, kept);
}

/** The secret in the file at `path`, created (mode 0600, in one step) with a fresh token when it does not exist yet. */
export async function secretFile(path: string): Promise<string> {
	const existing = await readSecret(path);
	if (existing !== undefined) return existing;
	const secret = newToken();
	const written = await writeSecret(path, secret, "create");
	return written === "exists" ? ((await readSecret(path)) ?? secret) : secret;
}

/** The text of the secret file at `path`, or `undefined` when it does not exist. */
export async function readSecret(path: string): Promise<string | undefined> {
	try {
		return (await readFile(path, "utf8")).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Writes `text` to `path` with mode 0600 in one step: a temporary file of the same directory (made exclusively, 0600)
 * linked into place (`create`: refused when `path` exists, `"exists"` returned) or renamed over it (`replace`).
 */
export async function writeSecret(
	path: string,
	text: string,
	mode: "create" | "replace",
): Promise<"written" | "exists"> {
	const temporary = join(dirname(path), `.${newToken(9)}.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${text}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		if (mode === "replace") {
			await rename(temporary, path);
			return "written";
		}
		await link(temporary, path);
		return "written";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
		throw error;
	} finally {
		await unlink(temporary).catch(() => {});
	}
}
