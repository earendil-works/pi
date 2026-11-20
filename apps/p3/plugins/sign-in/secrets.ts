// Tokens of the sign-in plugin: random, kept only as their SHA-256 hashes, compared in constant time.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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
