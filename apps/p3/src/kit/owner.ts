// The owner's sign-in: no owner by loopback alone. At each start the kit makes a one-time owner link (a random token,
// single use, valid 10 minutes, the previous one dropped); the start script prints it. Its page reads the token from
// the URL's fragment (never sent to a server, so never in a log) and posts it; the post consumes it and sets a browser
// sign-in cookie for the owner. The owner token file (mode 0600) carries a device sign-in of the owner for
// command-line clients on the same machine; with it, the `p3` command asks a running server for a fresh link.

import { chmod } from "node:fs/promises";
import { defineFacet, type Facet, type Host } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { Http, type ListenAddress } from "@earendil-works/chord/http";
import { PRINCIPALS } from "../app.ts";
import type { P3Principal } from "../principals.ts";
import { hashToken, matchesHash, newToken, readSecret, writeSecret } from "./secrets.ts";
import { SignIns } from "./sign-ins.ts";

/** How long an owner link is valid: 10 minutes. */
const OWNER_LINK_MS = 10 * 60_000;

/** The path of the owner link's page and post. */
export const OWNER_PATH = "/_p3/owner";

/** The path a signed-in owner posts to for a fresh owner link. */
export const OWNER_LINK_PATH = `${OWNER_PATH}/link`;

/** The owner link and its one-time token: made at each start and on request, consumed by its first use. */
export class OwnerLink {
	#hash: string | undefined;
	#expires = 0;
	/** Where the links point: the address listened on. */
	#origin: string | undefined;

	/** The server listens on `address`: links name it. */
	listening(address: ListenAddress): void {
		this.#origin = `http://${linkHost(address.host)}:${address.port}`;
	}

	/** A fresh link (the previous one no longer valid), valid 10 minutes: `http://127.0.0.1:<port>/_p3/owner#<token>`. */
	renew(): string {
		if (this.#origin === undefined) throw new Error("ownerLink: the server has not started");
		const token = newToken();
		this.#hash = hashToken(token);
		this.#expires = Date.now() + OWNER_LINK_MS;
		return `${this.#origin}${OWNER_PATH}#${token}`;
	}

	/** Whether `token` is the current one and has not expired; it is used up either way when it matches. */
	consume(token: string): boolean {
		const hash = this.#hash;
		if (hash === undefined || !matchesHash(token, hash)) return false;
		this.#hash = undefined;
		return Date.now() < this.#expires;
	}
}

/** The host of the owner link for the address listened on: loopback for a wildcard, an IPv6 address in brackets. */
function linkHost(host: string): string {
	if (host === "0.0.0.0" || host === "") return "127.0.0.1";
	if (host === "::") return "[::1]";
	return host.includes(":") ? `[${host}]` : host;
}

/**
 * The kit's facet for the owner link: `GET /_p3/owner`, a page posting the fragment's token, `POST /_p3/owner`, which
 * consumes it and answers with a sign-in cookie of the owner, and `POST /_p3/owner/link`, which answers a signed-in
 * owner with a fresh link.
 */
export function ownerFacet(link: OwnerLink): Facet<P3Principal> {
	return defineFacet<P3Principal>((_host, self) =>
		self.contribute(Http, {
			routes: {
				[`GET ${OWNER_PATH}`]: {
					public: true,
					handler: async (request) => ({ kind: "html", body: ownerPage(request.nonce) }),
				},
				[`POST ${OWNER_PATH}`]: {
					public: true,
					handler: async (request, ctx) => {
						const body = (await request.json()) as { readonly token?: unknown } | null;
						// A trust boundary: anyone may post here.
						if (typeof body?.token !== "string" || !link.consume(body.token))
							return { kind: "error", status: 403 };
						const signIns = await ctx.get(SignIns, {});
						const secure = request.provenance.kind !== "local";
						const owner = {
							principal: PRINCIPALS.owner,
							label: "owner browser",
							kind: "browser",
							secure,
						} as const;
						const issued = await signIns.issue(owner, ctx);
						return { kind: "json", value: "signed in", headers: { "Set-Cookie": issued.cookie } };
					},
				},
				[`POST ${OWNER_LINK_PATH}`]: {
					handler: async (_request, ctx) =>
						ctx.principal?.kind === "owner"
							? { kind: "json", value: { link: link.renew() } }
							: { kind: "error", status: 403 },
				},
			},
		}),
	);
}

/** The owner link's page: its script (the response's nonce) posts the fragment's token, then opens p3. */
function ownerPage(nonce: string): string {
	return [
		"<!doctype html><title>Sign in</title><p id=status>Signing in…</p>",
		`<script nonce="${nonce}">`,
		"const token = location.hash.slice(1); history.replaceState(null, '', location.pathname);",
		`fetch(${JSON.stringify(OWNER_PATH)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })`,
		"  .then((r) => { if (r.ok) location.replace('/'); else document.getElementById('status').textContent = 'This link is used up or expired.'; });",
		"</script>",
	].join("\n");
}

/**
 * The owner token file at `path`: kept when its token still authenticates as the owner (its sign-in exists, its secret
 * matches, it has not expired; its mode set to 0600 again), else a new device sign-in of the owner written there (mode
 * 0600, in one step). Its token, for the start script, which holds the data directory's server lock (`writeSecret`).
 */
export async function ownerTokenFile(path: string, host: Host<P3Principal>, context: Context): Promise<string> {
	const existing = await readSecret(path);
	return host.root(async (ctx) => {
		const signIns = await ctx.get(SignIns, {});
		if (existing !== undefined) {
			if ((await signIns.verify(existing, ctx))?.kind === "owner") {
				await chmod(path, 0o600);
				return existing;
			}
		}
		const owner = { principal: PRINCIPALS.owner, label: "owner token file", kind: "device" } as const;
		const { token } = await signIns.issue(owner, ctx);
		await writeSecret(path, token, existing === undefined ? "create" : "replace");
		return token;
	}, context);
}
