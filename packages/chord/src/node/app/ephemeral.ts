// The ephemeral login plugin (slice 13 §3, decision "The app kit, point 2"): an IRC-like "pick a name and you're in".
// `POST /_chord/login` (public: `{ name }`) issues an ephemeral session for `{ kind: "user", id: <fresh>, name }`
// (the app's principal type must allow it) and answers with its cookie. No account is stored. The session ends with
// the browser (its cookie has no lifetime) or the server (ephemeral sessions are dropped whenever it starts); ending it
// with the client's last link waits for slice 11's clients (carry-over). An exported facet, as `defineUsers`.

import type { Principal } from "../../data/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import { Http } from "../http/index.ts";
import { newToken } from "./secrets.ts";
import { Sessions } from "./sessions.ts";

/** The principal an ephemeral login gives. */
export type EphemeralUser = { readonly kind: "user"; readonly id: string; readonly name: string };

/** The longest name taken. */
const MAX_NAME = 40;

/** The ephemeral login plugin's server facet; a type error unless the app's principal type holds `EphemeralUser`. */
export function ephemeralLoginFacet<P extends Principal>(
	..._fits: EphemeralUser extends P ? [] : ["the app's principal type must hold { kind: 'user', id, name }"]
): Facet<P> {
	return defineFacet<P>((_host, self) =>
		self.contribute(Http, {
			routes: {
				"POST /_chord/login": {
					public: true,
					handler: async (request, ctx) => {
						// A trust boundary: anyone may log in under a name.
						const body = (await request.json(4096)) as { readonly name?: unknown } | null;
						const name = typeof body?.name === "string" ? body.name.trim().slice(0, MAX_NAME) : "";
						if (name === "") return { kind: "error", status: 400 };
						const principal: EphemeralUser = { kind: "user", id: newToken(12), name };
						const sessions = await ctx.get(Sessions, {});
						const secure = request.provenance.kind !== "local";
						const issued = await sessions.issue({ principal, label: name, kind: "ephemeral", secure }, ctx);
						return { kind: "json", value: principal, headers: { "Set-Cookie": issued.cookie } };
					},
				},
			},
		}),
	);
}
