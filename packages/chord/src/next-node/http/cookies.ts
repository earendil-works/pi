// Cookies (decision "The HTTP component's security baseline" (5)): `cookie` makes a signed `Set-Cookie` value with the
// safe defaults (`HttpOnly`, `Path=/`, `SameSite=Strict`, `Secure` on a remote origin), `readCookie` reads one back,
// its signature checked in constant time.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { HttpRequest } from "./request.ts";

/** What `cookie` takes besides the name and the value. */
export type CookieOptions = {
	/** The key it is signed with (HMAC-SHA256). */
	readonly secret: string;
	/** The request it answers: a remote one gets `Secure`. */
	readonly request: HttpRequest;
	/** `Strict` by default; `Lax` lets a top-level navigation from another site carry it. */
	readonly sameSite?: "Strict" | "Lax";
	/** Seconds until it expires; none: a session cookie. */
	readonly maxAge?: number;
};

/**
 * A signed `Set-Cookie` value for `name` and `value` (put it in a response's `headers`, `Set-Cookie`). With `maxAge`
 * its expiry is signed with it: a copy read back later is refused (Opus's recheck R3); without, it holds until the
 * secret changes.
 */
export function cookie(name: string, value: string, options: CookieOptions): string {
	const encoded = encodeURIComponent(value);
	const expires = options.maxAge === undefined ? "" : String(Math.floor(Date.now() / 1000 + options.maxAge));
	const payload = `${encoded}.${expires}`;
	const parts = [
		`${name}=${payload}.${signature(name, payload, options.secret)}`,
		"HttpOnly",
		"Path=/",
		`SameSite=${options.sameSite ?? "Strict"}`,
	];
	if (options.request.provenance.kind !== "local") parts.push("Secure");
	if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
	return parts.join("; ");
}

/**
 * The value of cookie `name` on `request` when its signature with `secret` holds and its signed expiry has not passed;
 * `undefined` otherwise.
 */
export function readCookie(request: HttpRequest, name: string, secret: string): string | undefined {
	for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
		const equals = pair.indexOf("=");
		if (equals < 0 || pair.slice(0, equals).trim() !== name) continue;
		const signed = pair.slice(equals + 1).trim();
		// From the right: the value may hold dots, the expiry and the signature never do.
		const dot = signed.lastIndexOf(".");
		const payload = signed.slice(0, dot);
		const expiresAt = payload.lastIndexOf(".");
		if (dot < 0 || expiresAt < 0) return undefined;
		const given = Buffer.from(signed.slice(dot + 1));
		const expected = Buffer.from(signature(name, payload, secret));
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
		const expires = payload.slice(expiresAt + 1);
		if (expires !== "" && Number(expires) * 1000 <= Date.now()) return undefined;
		try {
			return decodeURIComponent(payload.slice(0, expiresAt));
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** The signature of a cookie's name and payload (its encoded value and expiry). */
function signature(name: string, payload: string, secret: string): string {
	return createHmac("sha256", secret).update(`${name}=${payload}`).digest("base64url");
}
