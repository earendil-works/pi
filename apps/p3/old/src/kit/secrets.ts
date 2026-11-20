// Secrets of the kit: tokens from `crypto.randomBytes`, kept only as their SHA-256 hashes and compared in constant
// time, and secret files (the cookie key, the owner token file; the Pi's config and the records use the same write)
// put in place with mode 0600 in one rename, so no other OS user and no half-written file ever reads them.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
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

/**
 * The secret in the file at `path`, created (mode 0600, in one step) with a fresh token when it does not exist yet. Its
 * caller holds the data directory's server lock (`writeSecret`'s `create`).
 */
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
 * Writes `text` to `path` with mode 0600 in one step: into a temporary file of the same directory (made exclusively,
 * 0600), synced, then renamed into place. `replace` replaces what is there; `create` never does: when `path` exists
 * (a link too) it returns `"exists"` and writes nothing. No hard link: Android's app sandbox refuses them (EACCES), and a
 * Pi's first start failed there making its cookie secret. `create` checks, then renames: a second writer between the
 * two would be overwritten, so every caller of `create` holds the data directory's server lock (the server's start
 * makes the cookie secret and the owner token file; the Pi's config and the records only replace). The directory is
 * not synced after the rename: a power loss right after it may lose the file, which the next start writes again (a new
 * cookie secret signs every device out), and syncing a directory has no portable form (Windows opens none).
 */
export async function writeSecret(
	path: string,
	text: string,
	mode: "create" | "replace",
): Promise<"written" | "exists"> {
	const temporary = join(dirname(path), `.${newToken(9)}.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		try {
			await handle.writeFile(`${text}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (mode === "create" && (await exists(path))) return "exists";
		await rename(temporary, path);
		return "written";
	} finally {
		// Gone after the rename; left when `create` found the file, or when a step failed.
		await rm(temporary, { force: true });
	}
}

/** Whether anything is at `path` (a dangling link too). */
async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
