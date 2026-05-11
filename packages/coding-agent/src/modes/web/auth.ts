import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./http.js";

const COOKIE_NAME = "pi_web_token";

export function tokenCookie(token: string): string {
	return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`;
}

export function clearTokenCookie(): string {
	return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function parseCookies(header: string | undefined): Map<string, string> {
	const cookies = new Map<string, string>();
	for (const part of (header ?? "").split(";")) {
		const index = part.indexOf("=");
		if (index <= 0) continue;
		const key = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		cookies.set(key, decodeURIComponent(value));
	}
	return cookies;
}

export function requestHasToken(req: IncomingMessage, token: string): boolean {
	const auth = req.headers.authorization;
	if (auth === `Bearer ${token}`) return true;
	const cookies = parseCookies(req.headers.cookie);
	return cookies.get(COOKIE_NAME) === token;
}

export function assertAuthorized(req: IncomingMessage, token: string): void {
	if (!requestHasToken(req, token)) throw new HttpError(401, "Unauthorized");
}

export function assertSafeOrigin(req: IncomingMessage): void {
	const method = req.method ?? "GET";
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
	const origin = req.headers.origin;
	if (!origin) return;
	const host = req.headers.host;
	if (!host) throw new HttpError(403, "Missing host header");
	try {
		const originUrl = new URL(origin);
		if (originUrl.host !== host) throw new HttpError(403, "Invalid request origin");
	} catch (error) {
		if (error instanceof HttpError) throw error;
		throw new HttpError(403, "Invalid request origin");
	}
}

export function writeAuthRedirect(res: ServerResponse, location: string, token: string): void {
	res.writeHead(302, { location, "set-cookie": tokenCookie(token) });
	res.end();
}
