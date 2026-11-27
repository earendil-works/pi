// The invite link's page and post (R39): `GET /_p3/invite` posts the token from the URL's fragment, never sent to a
// server; `POST /_p3/invite` redeems it (`ThingsStore.redeemInvite`, `<invite>.<secret>`, as `Workspace.inviteLink`
// writes it). A browser signed in as a person puts that person in and keeps its sign-in; an anonymous one gets the new
// person the link makes, signed in: their sign-in issued before the link is spent, so a signer that fails spends none.

import {
	type Ctx,
	contribute,
	type FacetHost,
	isChordError,
	type P3Principal,
	type Reference,
	reportError,
} from "@earendil-works/p3/v1";
import { Http } from "@earendil-works/p3/v1/server";
import { ThingsStore } from "../things/contract.server.ts";
import { INVITE_PATH, SignIns } from "./contract.ts";
import { answer, type Issued, issue, linkPage, revoke } from "./link.ts";

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
						// Anonymous: the new person's sign-in is issued first, so a signer that refuses spends no link; a link
						// that does not redeem then has its sign-in revoked.
						const invitation = await things.invitation({ secret: body.token }, ctx);
						if (invitation === null) return { kind: "error", status: 403 };
						const newPerson = crypto.randomUUID();
						let issued: Issued;
						try {
							issued = await issue({ person: newPerson, name: invitation.name }, "invite", request, ctx);
						} catch (error) {
							// Only a refusal before issuing gives the link back; any other failure may have issued it: the link is
							// spent, and the sign-in it may have left (for a person who never exists) is revoked.
							if (!refusedBeforeIssuing(error)) await spentUnredeemed(things, body.token, newPerson, ctx);
							throw error;
						}
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
 * Whether the signer's failure `error` is a refusal before it issued anything: a typed one (its arguments invalid, or
 * the call forbidden). Anything else (a lost answer, a crash) may have issued the sign-in.
 */
function refusedBeforeIssuing(error: unknown): boolean {
	return isChordError(error) && (error.code === "invalid" || error.code === "forbidden");
}

/**
 * Spends link `secret` unredeemed and revokes every sign-in of `person` (the new person it would have made, who never
 * exists): after a signer's failure that may have issued one. A revocation that fails is reported (the sign-in names
 * nobody the store knows).
 */
async function spentUnredeemed(
	things: Reference<typeof ThingsStore>,
	secret: string,
	person: string,
	ctx: Ctx,
): Promise<void> {
	await things.spendInvite({ secret }, ctx);
	const signIns = await ctx.get(SignIns, {});
	await signIns
		.revokeOf({ person }, ctx)
		.catch((error: unknown) =>
			reportError("sign-in: a sign-in the invite route may have issued could not be revoked", error, ctx),
		);
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
