// SignIns (slice 13 §2, decision "The app kit, point 3: authentication"): the kit's object on the server that issues
// and revokes sign-ins, and its authenticator. A sign-in is a principal behind a token `<id>.<secret>` (random); only
// the secret's hash is kept. A browser carries its token in the kit's signed sign-in cookie (`HttpOnly`,
// `SameSite=Strict`), a command-line client in `Authorization: Bearer <token>`. Browser and device sign-ins persist in
// the server's store and expire after 400 days unused; ephemeral sign-ins (a pick-a-name login, a public route) live
// in memory only (`EphemeralSignIns`), at most `maxEphemeral` of them (past it the oldest ends), so a public login
// costs the same whatever came before; each ends with its client's connection (its last link closed, a grace period
// passed: the links endpoint's `opened` hook counts them), and none outlives the server's run.

import type { Context } from "../../context/index.ts";
import { arr, bool, local, map, method, num, obj, oneOf, opt, str, unknown } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { defineState } from "../../documents/index.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import {
	Authenticators,
	cookie,
	Http,
	type HttpRequest,
	type HttpWrap,
	type Provenance,
	readCookie,
	readSignedCookie,
} from "../http/index.ts";
import { EphemeralSignIns } from "./ephemeral-sign-ins.ts";
import { hashToken, matchesHash, newToken } from "./secrets.ts";

/** What a sign-in is for: a browser (its cookie), a device (a command-line client's token), an ephemeral login. */
export type SignInKind = "browser" | "device" | "ephemeral";

/** A browser or device sign-in as `SignIns.list` shows it: never its token or hash. */
export type SignInInfo = {
	readonly id: string;
	readonly label: string;
	readonly kind: "browser" | "device";
	readonly principal: unknown;
	readonly created: number;
	readonly lastUsed: number;
};

/** The kit's sign-ins (one per server): issue, verify, revoke, and the watchable list of persisted ones. */
export const SignIns = local("chord.app.sign-ins", {
	version: 1,
	params: {},
	members: {
		/** The browser and device sign-ins (ephemeral ones are not listed: there may be many, and they are short). */
		list: arr(
			obj({
				id: str(),
				label: str(),
				kind: oneOf("browser", "device"),
				principal: unknown(),
				created: num(),
				lastUsed: num(),
			}),
		),
		/**
		 * A new sign-in for `principal`: its id, its token (shown once, kept only hashed) and the sign-in cookie carrying
		 * it for a browser (`Set-Cookie`; `secure` for a remote one).
		 */
		issue: method(
			obj({
				principal: unknown(),
				label: str(),
				kind: oneOf("browser", "device", "ephemeral"),
				secure: opt(bool()),
			}),
			obj({ id: str(), token: str(), cookie: str() }),
		),
		/** The principal `token` authenticates as, or `null` (unknown, revoked, expired, malformed). */
		verify: method(str(), unknown()),
		/** Ends sign-in `id` at once: its token authenticates nothing more. */
		revoke: method(str()),
	},
});

/** The name of the kit's sign-in cookie. */
export const SIGN_IN_COOKIE = "chord-sign-in";

/** The stored sign-ins: by id, each with its secret's hash and its principal (as JSON text: any of the app's). */
const SignInsDocument = defineState("chord.app.sign-ins", {
	schema: obj({
		signIns: map(
			obj({
				hash: str(),
				label: str(),
				kind: oneOf("browser", "device"),
				principal: str(),
				created: num(),
				lastUsed: num(),
			}),
		),
	}),
	version: 1,
	initial: () => ({ signIns: {} }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
});

/** How often a sign-in's `lastUsed` is written at most: once a minute (not one commit per request). */
const TOUCH_MS = 60_000;

/** How long a persisted sign-in lives unused: 400 days, as its cookie. */
const SIGN_IN_IDLE_MS = 400 * 24 * 60 * 60_000;

/** The sign-ins' limits: how many ephemeral sign-ins live at once (1,000 by default; past it the oldest ends). */
export type SignInLimits = { readonly maxEphemeral?: number };

/** The kit's sign-ins: the facet for the server's core facets, and the links endpoint's `opened` hook. */
export type KitSignIns<P extends Principal> = {
	readonly facet: Facet<P>;
	/** A link opened with `request`'s credentials: an ephemeral sign-in's links are counted (it ends with its last). */
	readonly opened: (request: HttpRequest) => (() => void) | undefined;
};

/**
 * The kit's sign-ins: its facet serving `SignIns` (a host-lifetime object) and contributing its authenticator (the
 * bearer token first, else the sign-in cookie signed with `cookieSecret`), and the links hook ending an ephemeral
 * sign-in with its client's connection.
 */
export function createSignIns<P extends Principal>(cookieSecret: string, limits: SignInLimits = {}): KitSignIns<P> {
	const ephemeral = new EphemeralSignIns(limits.maxEphemeral ?? 1000);
	const opened = (request: HttpRequest): (() => void) | undefined => {
		const token = bearerToken(request) ?? readCookie(request, SIGN_IN_COOKIE, cookieSecret);
		const dot = token?.indexOf(".") ?? -1;
		return dot > 0 ? ephemeral.linkOpened(token!.slice(0, dot)) : undefined;
	};
	return { facet: signInsFacet<P>(cookieSecret, ephemeral), opened };
}

/** The facet of `createSignIns`. */
function signInsFacet<P extends Principal>(cookieSecret: string, ephemeral: EphemeralSignIns): Facet<P> {
	return defineFacet<P>((host) =>
		host.serve(SignIns, (_params, self) => {
			const document = self.state(SignInsDocument);
			const change = (fn: (signIns: Record<string, { lastUsed: number }>) => void, context: Context) =>
				// Not awaited by authentication: the request goes on; a write that fails is made again by a later request.
				void document.change((draft) => fn(draft.signIns), context).catch(() => {});
			/** The principal of `token`, or `undefined`; touches or lazily removes the persisted sign-in it names. */
			const authenticate = (token: string, context: Context): Principal | undefined => {
				const dot = token.indexOf(".");
				if (dot <= 0) return undefined;
				const id = token.slice(0, dot);
				const secret = token.slice(dot + 1);
				const short = ephemeral.get(id);
				if (short !== undefined) return matchesHash(secret, short.hash) ? short.principal : undefined;
				// A trust boundary: `id` is the client's (`Object.hasOwn`: no inherited member is a sign-in).
				const signIns = document.value.signIns;
				if (!Object.hasOwn(signIns, id)) return undefined;
				const signIn = signIns[id]!;
				if (!matchesHash(secret, signIn.hash)) return undefined;
				const now = Date.now();
				if (now - signIn.lastUsed > SIGN_IN_IDLE_MS) {
					change((draft) => {
						delete draft[id];
					}, context);
					return undefined;
				}
				if (now - signIn.lastUsed > TOUCH_MS) {
					change((draft) => {
						if (Object.hasOwn(draft, id)) draft[id]!.lastUsed = now;
					}, context);
				}
				// Stored by `issue` from a principal of the app's type.
				return JSON.parse(signIn.principal) as Principal;
			};
			self.contribute(Authenticators, (request, context) => {
				const token = bearerToken(request) ?? readCookie(request, SIGN_IN_COOKIE, cookieSecret);
				return token === undefined ? undefined : authenticate(token, context);
			});
			self.contribute(Http, { wraps: [rollingCookie(cookieSecret, authenticate)] });
			return {
				list: self.derive([document], ([value]) =>
					Object.entries(value.signIns).map(([id, { label, kind, principal, created, lastUsed }]) => ({
						id,
						label,
						kind,
						// Stored by `issue` as JSON text.
						principal: JSON.parse(principal) as JsonValue,
						created,
						lastUsed,
					})),
				),
				issue: async ({ principal, label, kind, secure }, ctx) => {
					const id = newToken(12);
					const secret = newToken(32);
					if (kind === "ephemeral") {
						// Principals are the app's: `issue`'s callers pass one of its type.
						ephemeral.issue(id, hashToken(secret), principal as Principal);
					} else {
						const now = Date.now();
						const stored = JSON.stringify(principal);
						await document.change((draft) => {
							draft.signIns[id] = {
								hash: hashToken(secret),
								label,
								kind,
								principal: stored,
								created: now,
								lastUsed: now,
							};
						}, ctx);
					}
					const token = `${id}.${secret}`;
					// Only whether the browser is remote matters to the cookie (`Secure`).
					const provenance: Provenance = secure === true ? { kind: "remote", host: "" } : { kind: "local" };
					const set = signInCookie(token, kind, { provenance }, cookieSecret);
					return { id, token, cookie: set };
				},
				verify: async (token, ctx) => (authenticate(token, ctx) as JsonValue | undefined) ?? null,
				revoke: async (id, ctx) => {
					if (ephemeral.revoke(id)) return null;
					await document.change((draft) => {
						delete draft.signIns[id];
					}, ctx);
					return null;
				},
			};
		}),
	);
}

/**
 * The sign-in cookie carrying `token` (a sign-in of `kind`) for a browser of `request`'s provenance: a persisted
 * sign-in's lives as long as the sign-in does unused (400 days, renewed by `rollingCookie`), an ephemeral one's only
 * while the browser runs.
 */
function signInCookie(
	token: string,
	kind: SignInKind,
	request: Pick<HttpRequest, "provenance">,
	secret: string,
): string {
	const maxAge = kind === "ephemeral" ? undefined : SIGN_IN_IDLE_MS / 1000;
	return cookie(SIGN_IN_COOKIE, token, { secret, request, maxAge });
}

/** How old a sign-in cookie gets before a response renews it: a day. */
const ROLL_MS = 24 * 60 * 60_000;

/**
 * The wrap around every route renewing the sign-in cookie a request signed in with once it is older than a day: the
 * response sets it again with a fresh signed expiry, so a browser used within every 400 days stays signed in. Not when
 * the route sets a cookie itself, nor for an ephemeral sign-in's (it has no expiry) or a token that no longer
 * authenticates.
 */
function rollingCookie(
	secret: string,
	authenticate: (token: string, context: Context) => Principal | undefined,
): HttpWrap {
	return {
		name: "chord.app.rolling-cookie",
		phase: "headers",
		scope: "all",
		wrap: async (request, next, ctx) => {
			const response = await next(request);
			if (ctx.principal === undefined || Object.keys(response.headers ?? {}).some(isSetCookie)) return response;
			const signed = readSignedCookie(request, SIGN_IN_COOKIE, secret);
			if (signed?.expires === undefined || signed.expires - Date.now() > SIGN_IN_IDLE_MS - ROLL_MS) return response;
			if (authenticate(signed.value, ctx) === undefined) return response;
			const renewed = signInCookie(signed.value, "browser", request, secret);
			return { ...response, headers: { ...response.headers, "Set-Cookie": renewed } };
		},
	};
}

/** Whether a header name is `Set-Cookie` (any case). */
function isSetCookie(name: string): boolean {
	return name.toLowerCase() === "set-cookie";
}

/** The token of an `Authorization: Bearer <token>` header. */
function bearerToken(request: HttpRequest): string | undefined {
	const header = request.headers.get("authorization");
	const match = header === null ? null : /^Bearer\s+(\S+)$/i.exec(header);
	return match?.[1];
}
