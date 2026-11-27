// What a sign-in link's route is made of, the owner link's and the invite link's alike: the page whose script posts
// the token from the URL's fragment (never sent to a server by the browser itself), and the browser sign-in a redeemed
// link answers with. A sign-in issued for a person a removal took meanwhile is revoked before it is answered: the
// removal ends the sign-ins it sees after its commit, the issuer checks after issuing, so none outlives both.

import type { Ctx } from "@earendil-works/p3/v1";
import type { HttpRequest, HttpResponse } from "@earendil-works/p3/v1/server";
import { ThingsStore } from "../things/contract.server.ts";
import { SignIns } from "./contract.ts";

/** A sign-in issued for a link, not yet answered: its id (to revoke it) and its cookie. */
export type Issued = { readonly id: string; readonly cookie: string };

/** A link's page at `path`: its script (the response's nonce) posts the fragment's token there, then opens p3. */
export function linkPage(path: string, nonce: string): string {
	return [
		"<!doctype html><title>Sign in</title><p id=status>Signing in…</p>",
		`<script nonce="${nonce}">`,
		"const token = location.hash.slice(1); history.replaceState(null, '', location.pathname);",
		`fetch(${JSON.stringify(path)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })`,
		"  .then((r) => { if (r.ok) location.replace('/'); else document.getElementById('status').textContent = 'This link is used up or expired.'; });",
		"</script>",
	].join("\n");
}

/** Issues a browser sign-in for `request`'s browser as `person` (labelled `label`), not yet answered (`answer`). */
export async function issue(
	{ person, name }: { readonly person: string; readonly name: string },
	label: string,
	request: HttpRequest,
	ctx: Ctx,
): Promise<Issued> {
	const principal = { kind: "person", id: person, name } as const;
	const secure = request.provenance.kind !== "local";
	const { id, cookie } = await (await ctx.get(SignIns, {})).issue({ principal, label, kind: "browser", secure }, ctx);
	return { id, cookie };
}

/**
 * The answer that sets sign-in `issued`'s cookie, once person `person` is still there; a person a removal took meanwhile
 * gets the sign-in revoked and a refusal (403).
 */
export async function answer(issued: Issued, person: string, ctx: Ctx): Promise<HttpResponse> {
	const things = await ctx.get(ThingsStore, {});
	if ((await things.persons.one.page({ person }, 1, ctx)).items.length === 0) {
		await revoke(issued, ctx);
		return { kind: "error", status: 403 };
	}
	return { kind: "json", value: "signed in", headers: { "Set-Cookie": issued.cookie } };
}

/** Revokes sign-in `issued`, never answered. */
export async function revoke(issued: Issued, ctx: Ctx): Promise<void> {
	await (await ctx.get(SignIns, {})).revoke(issued.id, ctx);
}
