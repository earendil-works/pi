// The invite plugin (slice 13 §3, decision "The app kit, point 2"): the owner makes an invite link for a principal of
// the app it chooses (`POST /_chord/invites`, owner only: `{ principal, label }` → `{ path }`); the invitee opens it,
// its page posts the token (the URL's fragment, never logged) to `POST /_chord/invite`, which consumes it (single use,
// 7 days) and answers with a browser session for that principal (§2's sessions). Invites wait in memory: a restart
// drops the ones not used. An exported facet, as `defineUsers` (see there why).

import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import { Http } from "../http/index.ts";
import { fragmentPage } from "./owner.ts";
import { hashToken, newToken } from "./secrets.ts";
import { Sessions } from "./sessions.ts";

/** How long an invite is valid: 7 days. */
const INVITE_MS = 7 * 24 * 60 * 60_000;

/** The invite link's path: its page, and the post that consumes it. */
const INVITE_PATH = "/_chord/invite";

/** An invite waiting: the principal it signs in, its label, its expiry. */
type Invite = { readonly principal: JsonValue; readonly label: string; readonly expires: number };

/** The invite plugin's server facet. */
export function inviteFacet<P extends Principal>(): Facet<P> {
	// By their token's hash: what the map holds is no credential.
	const invites = new Map<string, Invite>();
	return defineFacet<P>((_host, self) =>
		self.contribute(Http, {
			routes: {
				"POST /_chord/invites": async (request, ctx) => {
					if (ctx.principal?.kind !== "owner") return { kind: "error", status: 403 };
					// A trust boundary: the owner's request, checked for its shape.
					const body = (await request.json()) as {
						readonly principal?: JsonValue;
						readonly label?: unknown;
					} | null;
					const principal = body?.principal;
					if (typeof principal !== "object" || principal === null || typeof body?.label !== "string") {
						return { kind: "error", status: 400 };
					}
					const token = newToken();
					invites.set(hashToken(token), { principal, label: body.label, expires: Date.now() + INVITE_MS });
					return { kind: "json", value: { path: `${INVITE_PATH}#${token}` } };
				},
				[`GET ${INVITE_PATH}`]: {
					public: true,
					handler: async (request) => ({ kind: "html", body: fragmentPage(INVITE_PATH, request.nonce) }),
				},
				[`POST ${INVITE_PATH}`]: {
					public: true,
					handler: async (request, ctx) => {
						// A trust boundary: anyone may post here.
						const body = (await request.json()) as { readonly token?: unknown } | null;
						const hash = typeof body?.token === "string" ? hashToken(body.token) : undefined;
						const invite = hash === undefined ? undefined : invites.get(hash);
						if (hash === undefined || invite === undefined) return { kind: "error", status: 403 };
						invites.delete(hash);
						if (invite.expires <= Date.now()) return { kind: "error", status: 403 };
						const sessions = await ctx.get(Sessions, {});
						const secure = request.provenance.kind !== "local";
						const issued = await sessions.issue(
							{ principal: invite.principal, label: invite.label, kind: "browser", secure },
							ctx,
						);
						return { kind: "json", value: "signed in", headers: { "Set-Cookie": issued.cookie } };
					},
				},
			},
		}),
	);
}
