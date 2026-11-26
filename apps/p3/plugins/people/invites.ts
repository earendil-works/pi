// Invite links: one per person at a time, single use, valid 10 minutes, kept only hashed and in memory (as the owner
// link). The link's page (`GET /_p3/invite`) posts the token from the URL's fragment, never sent to a server; its post
// (`POST /_p3/invite`) consumes it and signs the browser in as the person (a sign-in of the sign-in plugin).

import { contribute, type FacetHost, type P3Principal } from "@earendil-works/p3/v1";
import { Http, hashToken, matchesHash, newToken } from "@earendil-works/p3/v1/server";
import { SignIns } from "../sign-in/contract.ts";
import { PeopleStore } from "./contract.server.ts";

/** How long an invite link is valid: 10 minutes. */
const INVITE_MS = 10 * 60_000;

/** The invite link's page and post. */
export const INVITE_PATH = "/_p3/invite";

/** The open invites by person: each its token's hash and when it expires. */
export class Invites {
	readonly #open = new Map<string, { readonly hash: string; readonly expires: number }>();

	/** A fresh link path of `person` (`/_p3/invite#<person>.<secret>`); their previous one is no longer valid. */
	renew(person: string): string {
		const secret = newToken();
		this.#open.set(person, { hash: hashToken(secret), expires: Date.now() + INVITE_MS });
		return `${INVITE_PATH}#${person}.${secret}`;
	}

	/** The person `token` invites, if it is their current one and has not expired; used up either way when it matches. */
	consume(token: string): string | undefined {
		const dot = token.indexOf(".");
		if (dot <= 0) return undefined;
		const person = token.slice(0, dot);
		const invite = this.#open.get(person);
		if (invite === undefined || !matchesHash(token.slice(dot + 1), invite.hash)) return undefined;
		this.#open.delete(person);
		return Date.now() < invite.expires ? person : undefined;
	}

	/** Drops `person`'s open invite (they were removed). */
	drop(person: string): void {
		this.#open.delete(person);
	}
}

/** Serves the invite link's page and post on `host`, consuming `invites`. */
export function serveInviteRoutes(host: FacetHost<P3Principal>, invites: Invites): void {
	contribute(host, "people.invite-routes", (self) => {
		self.contribute(Http, {
			routes: {
				[`GET ${INVITE_PATH}`]: {
					public: true,
					handler: async (request) => ({ kind: "html", body: invitePage(request.nonce) }),
				},
				[`POST ${INVITE_PATH}`]: {
					public: true,
					handler: async (request, ctx) => {
						const body = (await request.json()) as { readonly token?: unknown } | null;
						// A trust boundary: anyone may post here.
						const person = typeof body?.token === "string" ? invites.consume(body.token) : undefined;
						if (person === undefined) return { kind: "error", status: 403 };
						const found = await (await ctx.get(PeopleStore, {})).persons.one.page({ id: person }, 1, ctx);
						const name = found.items[0]?.name;
						if (name === undefined) return { kind: "error", status: 403 };
						const secure = request.provenance.kind !== "local";
						const principal = { kind: "person", id: person, name } as const;
						const signIns = await ctx.get(SignIns, {});
						const issued = await signIns.issue({ principal, label: "invite", kind: "browser", secure }, ctx);
						return { kind: "json", value: "signed in", headers: { "Set-Cookie": issued.cookie } };
					},
				},
			},
		});
	});
}

/** The invite link's page: its script (the response's nonce) posts the fragment's token, then opens p3. */
function invitePage(nonce: string): string {
	return [
		"<!doctype html><title>Sign in</title><p id=status>Signing in…</p>",
		`<script nonce="${nonce}">`,
		"const token = location.hash.slice(1); history.replaceState(null, '', location.pathname);",
		`fetch(${JSON.stringify(INVITE_PATH)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })`,
		"  .then((r) => { if (r.ok) location.replace('/'); else document.getElementById('status').textContent = 'This link is used up or expired.'; });",
		"</script>",
	].join("\n");
}
