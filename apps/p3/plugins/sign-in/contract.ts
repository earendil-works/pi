// The sign-in plugin's contract: the server's sign-ins. A sign-in is one browser or device signed in as a principal,
// behind a token `<id>.<secret>` (random); only the secret's hash is kept.

import { arr, bool, local, method, nul, num, obj, oneOf, opt, P3Principal, str, union } from "@earendil-works/p3/v1";

/** The invite link's page and post (`invite.ts`); `Workspace.inviteLink` answers links to it, `#<token>` after it. */
export const INVITE_PATH = "/_p3/invite";

/** The server's sign-ins (one per server): issue, verify, revoke, and the live list of them. */
export const SignIns = local("p3.sign-ins", {
	version: 1,
	params: {},
	members: {
		/** The sign-ins: never a token or a hash. */
		list: arr(
			obj({
				id: str(),
				label: str(),
				kind: oneOf("browser", "device"),
				principal: P3Principal,
				created: num(),
				lastUsed: num(),
			}),
		),
		/**
		 * A new sign-in for `principal`: its id, its token (shown once, kept only hashed) and the sign-in cookie carrying
		 * it for a browser (`Set-Cookie`; `secure` for a remote one).
		 */
		issue: method(
			obj({ principal: P3Principal, label: str(), kind: oneOf("browser", "device"), secure: opt(bool()) }),
			obj({ id: str(), token: str(), cookie: str() }),
		),
		/** The principal `token` authenticates as, or `null` (unknown, revoked, expired, malformed). */
		verify: method(str(), union([P3Principal, nul()])),
		/** Ends sign-in `id` at once: its token authenticates nothing more, and its open links are closed. */
		revoke: method(str()),
	},
});
