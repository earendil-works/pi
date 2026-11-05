/**
 * Signed, short-lived tokens for the owner sign-in: the session cookie and the OAuth state cookie.
 *
 * A token is `base64url(JSON payload).base64url(HMAC-SHA256)`. The secret comes from the environment and is
 * never logged. Verification is constant-time, checks expiry, and returns undefined for anything malformed,
 * so callers fail closed. No server-side session store is kept.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const MIN_SECRET_LENGTH = 32;

export interface TokenPayload {
  /** Expiry, epoch seconds. */
  exp: number;
  [key: string]: unknown;
}

function mac(secret: string, body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest();
}

/** True when the secret is long enough to sign with. */
export function secretUsable(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

/** Signs a payload. Throws if the secret is too short, so a weak secret never signs anything. */
export function signToken(secret: string | undefined, payload: TokenPayload): string {
  if (!secretUsable(secret)) throw new Error("Session secret is missing or too short");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

/** Returns the payload if the token is genuine and unexpired, otherwise undefined. */
export function verifyToken(
  secret: string | undefined,
  token: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): TokenPayload | undefined {
  if (!secretUsable(secret) || typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [body, signature] = parts as [string, string];
  const expected = mac(secret, body);
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return undefined;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    if (payload === null || typeof payload !== "object") return undefined;
    const exp = (payload as TokenPayload).exp;
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= nowSeconds) return undefined;
    return payload as TokenPayload;
  } catch {
    return undefined;
  }
}

/** Reads one cookie from a Cookie header value. */
export function readCookie(header: string | string[] | undefined, name: string): string | undefined {
  const text = Array.isArray(header) ? header.join("; ") : header;
  if (!text) return undefined;
  for (const part of text.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/** Builds a Set-Cookie value: HttpOnly, Secure, SameSite=Lax, path /. A maxAge of 0 clears the cookie. */
export function cookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}
