// The owner (slice 13 §2, decision "The app kit, point 3: authentication"): no owner by loopback alone. At each start
// the kit makes a one-time owner link (a random token, single use, valid 10 minutes, the previous one dropped); the
// start script prints it. Its page reads the token from the URL's fragment (never sent to a server, so never in a
// log) and posts it; the post consumes it and sets a browser session cookie for the owner. The owner token file
// (mode 0600) carries a device session of the owner for command-line clients on the same machine.

import { chmod } from "node:fs/promises";
import type { Context } from "../../context/index.ts";
import type { Principal } from "../../next/data/index.ts";
import { defineFacet, type Facet, type Host } from "../../next/host/index.ts";
import { Http } from "../http/index.ts";
import { hashToken, matchesHash, newToken, readSecret, writeSecret } from "./secrets.ts";
import { Sessions } from "./sessions.ts";

/** The kit's owner principal: a variant every app's principal type has. */
export type OwnerPrincipal = { readonly kind: "owner" };

/** The owner principal. */
export const OWNER: OwnerPrincipal = { kind: "owner" };

/** How long an owner link is valid: 10 minutes. */
const OWNER_LINK_MS = 10 * 60_000;

/** The owner link's one-time token: made at each start (the previous one dropped), consumed by its first use. */
export class OwnerLink {
	#hash: string | undefined;
	#expires = 0;

	/** A fresh token (the previous one no longer valid), valid for 10 minutes. */
	renew(): string {
		const token = newToken();
		this.#hash = hashToken(token);
		this.#expires = Date.now() + OWNER_LINK_MS;
		return token;
	}

	/** Whether `token` is the current one and has not expired; it is used up either way when it matches. */
	consume(token: string): boolean {
		const hash = this.#hash;
		if (hash === undefined || !matchesHash(token, hash)) return false;
		this.#hash = undefined;
		return Date.now() < this.#expires;
	}
}

/** The path of the owner link's page and post. */
export const OWNER_PATH = "/_chord/owner";

/**
 * The kit's facet for the owner link: `GET /_chord/owner`, a page posting the fragment's token, and `POST
 * /_chord/owner`, which consumes it and answers with the owner's session cookie.
 */
export function ownerFacet<P extends Principal>(link: OwnerLink): Facet<P> {
	return defineFacet<P>((_host, self) =>
		self.contribute(Http, {
			routes: {
				[`GET ${OWNER_PATH}`]: {
					public: true,
					handler: async (request) => ({ kind: "html", body: fragmentPage(OWNER_PATH, request.nonce) }),
				},
				[`POST ${OWNER_PATH}`]: {
					public: true,
					handler: async (request, ctx) => {
						const body = (await request.json()) as { readonly token?: unknown } | null;
						// A trust boundary: anyone may post here.
						if (typeof body?.token !== "string" || !link.consume(body.token))
							return { kind: "error", status: 403 };
						const sessions = await ctx.get(Sessions, {});
						const secure = request.provenance.kind !== "local";
						const issued = await sessions.issue(
							{ principal: OWNER, label: "owner browser", kind: "browser", secure },
							ctx,
						);
						return { kind: "json", value: "signed in", headers: { "Set-Cookie": issued.cookie } };
					},
				},
			},
		}),
	);
}

/**
 * A sign-in page for a link with a token in its fragment (the owner link, an invite): its script (the response's nonce)
 * posts the token to `path`, then opens the app.
 */
export function fragmentPage(path: string, nonce: string): string {
	return [
		"<!doctype html><title>Sign in</title><p id=status>Signing in…</p>",
		`<script nonce="${nonce}">`,
		"const token = location.hash.slice(1); history.replaceState(null, '', location.pathname);",
		`fetch(${JSON.stringify(path)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })`,
		"  .then((r) => { if (r.ok) location.replace('/'); else document.getElementById('status').textContent = 'This link is used up or expired.'; });",
		"</script>",
	].join("\n");
}

/**
 * The owner token file at `path`: kept when its token still authenticates as the owner (its session exists, its secret
 * matches, it has not expired; its mode set to 0600 again), else a new device session of the owner written there (mode
 * 0600, in one step). Its token, for the start script.
 */
export async function ownerTokenFile<P extends Principal>(
	path: string,
	host: Host<P>,
	context: Context,
): Promise<string> {
	const existing = await readSecret(path);
	return host.root(async (ctx) => {
		const sessions = await ctx.get(Sessions, {});
		if (existing !== undefined && isOwner(await sessions.verify(existing, ctx))) {
			await chmod(path, 0o600);
			return existing;
		}
		const { token } = await sessions.issue({ principal: OWNER, label: "owner token file", kind: "device" }, ctx);
		await writeSecret(path, token, existing === undefined ? "create" : "replace");
		return token;
	}, context);
}

/** Whether `principal` (as `Sessions.verify` gives it) is the owner. */
function isOwner(principal: unknown): boolean {
	return typeof principal === "object" && principal !== null && (principal as { kind?: unknown }).kind === "owner";
}
