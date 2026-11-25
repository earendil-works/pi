// Tokens of the sign-in plugin: random, kept only as their SHA-256 hashes, compared in constant time; and the owner
// token file written with mode 0600 in one step.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
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

/** The text of the file at `path`, trimmed, or `undefined` when it does not exist. */
export async function readSecret(path: string): Promise<string | undefined> {
	try {
		return (await readFile(path, "utf8")).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Writes `text` to `path` with mode 0600 in one step: a temporary file of the same directory, synced, renamed. */
export async function writeSecret(path: string, text: string): Promise<void> {
	const temporary = join(dirname(path), `.${newToken(9)}.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${text}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, path).catch(async (error: unknown) => {
		await rm(temporary, { force: true });
		throw error;
	});
}
