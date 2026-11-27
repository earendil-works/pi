// The invite link's page and post (R39): `GET /_p3/invite` posts the token from the URL's fragment, never sent to a
// server; `POST /_p3/invite` redeems it (`ThingsStore.redeemInvite`, `<invite>.<secret>`, as `Workspace.inviteLink`
// writes it). A browser signed in as a person puts that person in and keeps its sign-in; an anonymous one gets the new
// person the link makes, signed in: their sign-in issued before the link is spent, so a signer that fails spends none.

import { type Ctx, contribute, type FacetHost, type P3Principal, type Reference } from "@earendil-works/p3/v1";
import { Http } from "@earendil-works/p3/v1/server";
import { ThingsStore } from "../things/contract.server.ts";
import { INVITE_PATH } from "./contract.ts";
import { answer, issue, linkPage, revoke } from "./link.ts";

/** Serves the invite link's page and post on `host`. */
export function serveInvite(host: FacetHost<P3Principal>): void {
	contribute(host, "sign-in.invite", (self) => {
		self.contribute(Http, {
			routes: {
				[`GET ${INVITE_PATH}`]: {
					public: true,
					handler: async (request) => ({ kind: "html", body: linkPage(INVITE_PATH, request.nonce) }),
				},
				[`POST ${INVITE_PATH}`]: {
					public: true,
					handler: async (request, ctx) => {
						const body = (await request.json()) as { readonly token?: unknown } | null;
						// A trust boundary: anyone may post here.
						if (typeof body?.token !== "string") return { kind: "error", status: 403 };
						const things = await ctx.get(ThingsStore, {});
						const signedIn = await personOf(ctx, things);
						if (signedIn !== undefined) {
							// Signed in already: put in as themself, the browser keeps its sign-in.
							const invited = await things.redeemInvite({ secret: body.token, person: signedIn }, ctx);
							return invited === null ? { kind: "error", status: 403 } : { kind: "json", value: "signed in" };
						}
						// Anonymous: the new person's sign-in is issued first, so a signer that fails spends no link; a link
						// that does not redeem then has its sign-in revoked.
						const invitation = await things.invitation({ secret: body.token }, ctx);
						if (invitation === null) return { kind: "error", status: 403 };
						const newPerson = crypto.randomUUID();
						const issued = await issue({ person: newPerson, name: invitation.name }, "invite", request, ctx);
						let invited: { readonly person: string } | null;
						try {
							invited = await things.redeemInvite({ secret: body.token, newPerson }, ctx);
						} catch (error) {
							await revoke(issued, ctx);
							throw error;
						}
						if (invited === null) {
							await revoke(issued, ctx);
							return { kind: "error", status: 403 };
						}
						return answer(issued, newPerson, ctx);
					},
				},
			},
		});
	});
}

/**
 * The person the request's sign-in is, if it is a person's who still exists (a browser signed in as a removed person
 * redeems as an anonymous one).
 */
async function personOf(ctx: Ctx, things: Reference<typeof ThingsStore>): Promise<string | undefined> {
	// The server authenticated it: a P3 principal (Chord types an HTTP route's principal as any app's).
	const me = ctx.principal as P3Principal | undefined;
	if (me?.kind !== "person") return undefined;
	return (await things.persons.one.page({ person: me.id }, 1, ctx)).items.length > 0 ? me.id : undefined;
}
