// The loopback owner's browser cookie (Pi Mobile's loopback owner cookie, apps/mobile/src/server/http.ts): set when the
// owner's browser loads the app on loopback. Loopback requests without any cookie are still the owner (`access:
// "local"`: the TUI, owner-link, the app's first page load), but only a browser carrying this cookie is the owner for the
// share join page, and it takes precedence over a guest cookie in the same browser. A browser that joined a share
// without it (a fresh profile opening a share link) is that guest everywhere. Meaningless off loopback: checked only
// there. Not the owner cookies of associated devices (`plugins/devices`, `access: "device"`). The cookie and its secret
// file keep their names (`p2_device_<port>`, `device-cookie`), so browsers that have it keep it.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { cookieValue } from "./http.ts";

const secrets = new Map<string, string>();

/** The data directory's cookie value (`device-cookie`, created once, private). */
function secretOf(dataDir: string): string {
	let secret = secrets.get(dataDir);
	if (secret) return secret;
	const path = join(dataDir, "device-cookie");
	try {
		secret = readFileSync(path, "utf8").trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try {
			writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
		} catch (raced) {
			if ((raced as NodeJS.ErrnoException).code !== "EEXIST") throw raced;
		}
		secret = readFileSync(path, "utf8").trim();
	}
	if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error(`Invalid ${path}`);
	secrets.set(dataDir, secret);
	return secret;
}

export const loopbackCookieName = (port: number): string => `p2_device_${port}`;

/** The `Set-Cookie` value for the owner's browser on loopback. */
export const loopbackCookie = (port: number, dataDir: string): string =>
	`${loopbackCookieName(port)}=${secretOf(dataDir)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;

/** Whether the request carries the loopback owner cookie (the caller checks that it came over loopback). */
export function hasLoopbackCookie(request: IncomingMessage, port: number, dataDir: string): boolean {
	const value = cookieValue(request, loopbackCookieName(port));
	if (value === undefined) return false;
	const expected = Buffer.from(secretOf(dataDir));
	const actual = Buffer.from(value);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
