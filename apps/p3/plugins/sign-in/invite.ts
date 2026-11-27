// The invite link's page and post (R39): `GET /_p3/invite` posts the token from the URL's fragment, never sent to a
// server; `POST /_p3/invite` redeems it (`ThingsStore.redeemInvite`, `<invite>.<secret>`, as `Workspace.inviteLink`
// writes it). A browser signed in as a person puts that person in and keeps its sign-in; an anonymous one gets the new
// person the link makes, signed in.

import { type Ctx, contribute, type FacetHost, type P3Principal } from "@earendil-works/p3/v1";
import { Http } from "@earendil-works/p3/v1/server";
import { ThingsStore } from "../things/contract.server.ts";
import { INVITE_PATH, SignIns } from "./contract.ts";

/** Serves the invite link's page and post on `host`. */
export function serveInvite(host: FacetHost<P3Principal>): void {
	contribute(host, "sign-in.invite", (self) => {
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
						if (typeof body?.token !== "string") return { kind: "error", status: 403 };
						const signedIn = personOf(ctx);
						const things = await ctx.get(ThingsStore, {});
						const at = signedIn === undefined ? {} : { person: signedIn };
						const invited = await things.redeemInvite({ secret: body.token, ...at }, ctx);
						if (invited === null) return { kind: "error", status: 403 };
						// Signed in already: the browser keeps its sign-in.
						if (signedIn !== undefined) return { kind: "json", value: "signed in" };
						const secure = request.provenance.kind !== "local";
						const principal = { kind: "person", id: invited.person, name: invited.name } as const;
						const signIns = await ctx.get(SignIns, {});
						const issued = await signIns.issue({ principal, label: "invite", kind: "browser", secure }, ctx);
						return { kind: "json", value: "signed in", headers: { "Set-Cookie": issued.cookie } };
					},
				},
			},
		});
	});
}

/** The person the request's sign-in is (authenticated by the server: a P3 principal), if it is a person's. */
function personOf(ctx: Ctx): string | undefined {
	const me = ctx.principal;
	return me?.kind === "person" && typeof me.id === "string" ? me.id : undefined;
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
