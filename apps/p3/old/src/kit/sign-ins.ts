// SignIns: the kit's object on the server that issues and revokes sign-ins, and its authenticator. A sign-in is one
// browser or device signed in as a principal, behind a token `<id>.<secret>` (random); only the secret's hash is kept.
// A browser carries its token in the signed sign-in cookie (`HttpOnly`, `SameSite=Strict`), a command-line client in
// `Authorization: Bearer <token>`. Sign-ins persist in the server's store and expire after 400 days unused. A sign-in
// that ends (revoked, expired) takes its open links with it: the kit hears each link the HTTP component accepts.

import {
	arr,
	bool,
	defineFacet,
	defineState,
	type Facet,
	type HandleOf,
	local,
	map,
	method,
	nul,
	num,
	obj,
	oneOf,
	opt,
	str,
	union,
} from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import {
	Authenticators,
	cookie,
	Http,
	type HttpRequest,
	type HttpWrap,
	type Provenance,
	readCookie,
	readSignedCookie,
} from "@earendil-works/chord/http";
import { P3Principal } from "../principals.ts";
import { hashToken, matchesHash, newToken } from "./secrets.ts";

/** What a sign-in is for: a browser (its cookie) or a device (a command-line client's token). */
export type SignInKind = "browser" | "device";

/** The kit's sign-ins (one per server): issue, verify, revoke, and the watchable list of them. */
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

/**
 * The sign-in cookie of one Pi: its name, which holds the Pi's id (a browser shares cookies between the ports of one
 * host, so two Pis on a machine need two names), and the secret that signs it.
 */
export type SignInCookie = { readonly name: string; readonly secret: string };

/** The sign-in cookie of the Pi `id`, signed with `secret`. */
export function signInCookieOf(id: string, secret: string): SignInCookie {
	return { name: `p3-${id}`, secret };
}

/** The stored sign-ins: by id, each with its secret's hash and its principal. */
const SignInsDocument = defineState("p3.sign-ins", {
	schema: obj({
		signIns: map(
			obj({
				hash: str(),
				label: str(),
				kind: oneOf("browser", "device"),
				principal: P3Principal,
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

/** The kit's sign-ins: the facet for the server's core facets, and the links endpoint's `opened` hook. */
export type KitSignIns = {
	readonly facet: Facet<P3Principal>;
	/**
	 * A link was accepted for `request`: `close` ends it when the sign-in the request authenticated with ends, at once
	 * when it has ended already. The signature is Chord's (`createHttp`'s `links.opened`): the kit needs the sign-in,
	 * which it noted when it authenticated the request, not the principal.
	 */
	readonly opened: (request: HttpRequest, principal: unknown, close: () => void) => (() => void) | undefined;
};

/**
 * The kit's sign-ins: its facet serving `SignIns` (a host-lifetime object) and contributing its authenticator (the
 * bearer token first, else the sign-in cookie named and signed by `key`) and the wrap that renews a browser's cookie,
 * and the links hook through which a sign-in that ends closes its open links.
 */
export function createSignIns(key: SignInCookie): KitSignIns {
	const links = new SignInLinks();
	return {
		facet: signInsFacet(key, links),
		opened: (request, _principal, close) => links.opened(request, close),
	};
}

/** The open links of each sign-in, by its id: what closes each; and which sign-in each request authenticated with. */
class SignInLinks {
	readonly #closes = new Map<string, Set<() => void>>();
	/** The sign-in each request authenticated with, kept while the HTTP component keeps the request. */
	readonly #requests = new WeakMap<HttpRequest, string>();
	/** Whether a sign-in is live now: `SignIns` says, once it serves; before, none is. */
	#live: (id: string) => boolean = () => false;

	/** `SignIns` serves: `live` says whether a sign-in exists and has not expired, read when a link opens. */
	serve(live: (id: string) => boolean): void {
		this.#live = live;
	}

	/** `request` authenticated with sign-in `id`: a link it opens is that sign-in's. */
	signedIn(request: HttpRequest, id: string): void {
		this.#requests.set(request, id);
	}

	/**
	 * A link opened for `request`; `close` ends it. Its sign-in is the one the request authenticated with, never read
	 * from the request again: a cookie that expired meanwhile would name none. A request another authenticator signed
	 * in is not the kit's to close. A sign-in may end between the authenticator's answer and this call (the upgrade is
	 * asynchronous): the link of one that is not live now is closed at once, and the check and the registration are
	 * one synchronous step, so an end after it finds the link. Returns what to call when the link closed.
	 */
	opened(request: HttpRequest, close: () => void): (() => void) | undefined {
		const id = this.#requests.get(request);
		if (id === undefined) return undefined;
		if (!this.#live(id)) {
			close();
			return undefined;
		}
		const closes = this.#closes.get(id) ?? new Set();
		this.#closes.set(id, closes.add(close));
		return () => {
			closes.delete(close);
			if (closes.size === 0) this.#closes.delete(id);
		};
	}

	/** Closes every open link of sign-in `id`: only its own, whoever else is signed in as the same principal. */
	close(id: string): void {
		for (const close of this.#closes.get(id) ?? []) close();
	}
}

/** How long a sign-in lives unused: 400 days, as its cookie. */
const SIGN_IN_IDLE_MS = 400 * 24 * 60 * 60_000;

/** The facet of `createSignIns`. */
function signInsFacet(key: SignInCookie, links: SignInLinks): Facet<P3Principal> {
	return defineFacet<P3Principal>((host) =>
		host.serve(SignIns, (_params, self) => {
			const document = self.state(SignInsDocument);
			links.serve((id) => {
				const signIns = document.value.signIns;
				return Object.hasOwn(signIns, id) && Date.now() - signIns[id]!.lastUsed <= SIGN_IN_IDLE_MS;
			});
			/** Ends sign-in `id`: removed from the store, then its open links closed. */
			const end = async (id: string, context: Context): Promise<null> => {
				await document.change((draft) => {
					delete draft.signIns[id];
				}, context);
				links.close(id);
				return null;
			};
			const authenticate = (token: string, context: Context) => authenticated(document, token, end, context);
			self.contribute(Authenticators, (request, context) => {
				const token = requestToken(request, key);
				const principal = token === undefined ? undefined : authenticate(token, context);
				// A token that authenticates names its sign-in.
				if (principal !== undefined) links.signedIn(request, signInOf(token!)!);
				return principal;
			});
			self.contribute(Http, { wraps: [rollingCookie(key, authenticate)] });
			return {
				list: self.derive([document], ([value]) =>
					Object.entries(value.signIns).map(([id, { hash: _, ...shown }]) => ({ id, ...shown })),
				),
				issue: async ({ principal, label, kind, secure }, ctx) => {
					const id = newToken(12);
					const secret = newToken(32);
					const now = Date.now();
					await document.change((draft) => {
						draft.signIns[id] = { hash: hashToken(secret), label, kind, principal, created: now, lastUsed: now };
					}, ctx);
					const token = `${id}.${secret}`;
					// Only whether the browser is remote matters to the cookie (`Secure`).
					const provenance: Provenance = secure === true ? { kind: "remote", host: "" } : { kind: "local" };
					return { id, token, cookie: signInCookie(token, { provenance }, key) };
				},
				verify: async (token, ctx) => authenticate(token, ctx) ?? null,
				revoke: end,
			};
		}),
	);
}

/** How often a sign-in's `lastUsed` is written at most: once a minute (not one commit per request). */
const TOUCH_MS = 60_000;

/**
 * The principal `token` authenticates as among `document`'s sign-ins, or `undefined`. It touches the sign-in it names,
 * or ends it (`end`) when it was unused too long; neither is awaited: the request goes on, and a write that fails is
 * made again by a later request.
 */
function authenticated(
	document: HandleOf<typeof SignInsDocument>,
	token: string,
	end: (id: string, context: Context) => Promise<null>,
	context: Context,
): P3Principal | undefined {
	const id = signInOf(token);
	// A trust boundary: `id` is the client's (`Object.hasOwn`: no inherited member is a sign-in).
	const signIns = document.value.signIns;
	if (id === undefined || !Object.hasOwn(signIns, id)) return undefined;
	const signIn = signIns[id]!;
	if (!matchesHash(token.slice(id.length + 1), signIn.hash)) return undefined;
	const now = Date.now();
	if (now - signIn.lastUsed > SIGN_IN_IDLE_MS) {
		void end(id, context).catch(() => {});
		return undefined;
	}
	if (now - signIn.lastUsed > TOUCH_MS) {
		const touch = document.change((draft) => {
			if (Object.hasOwn(draft.signIns, id)) draft.signIns[id]!.lastUsed = now;
		}, context);
		void touch.catch(() => {});
	}
	return signIn.principal;
}

/** The id of the sign-in a token `<id>.<secret>` names, or `undefined` for a text that is no token. */
function signInOf(token: string): string | undefined {
	const dot = token.indexOf(".");
	return dot > 0 ? token.slice(0, dot) : undefined;
}

/** The token `request` carries: its bearer token first, else its sign-in cookie, named and signed by `key`. */
function requestToken(request: HttpRequest, key: SignInCookie): string | undefined {
	const header = request.headers.get("authorization");
	const bearer = header === null ? null : /^Bearer\s+(\S+)$/i.exec(header);
	return bearer?.[1] ?? readCookie(request, key.name, key.secret);
}

/**
 * The sign-in cookie carrying `token` for a browser of `request`'s provenance: it lives as long as the sign-in does
 * unused (400 days, renewed by `rollingCookie`).
 */
function signInCookie(token: string, request: Pick<HttpRequest, "provenance">, key: SignInCookie): string {
	return cookie(key.name, token, { secret: key.secret, request, maxAge: SIGN_IN_IDLE_MS / 1000 });
}

/** How old a sign-in cookie gets before a response renews it: a day. */
const ROLL_MS = 24 * 60 * 60_000;

/**
 * The wrap around every route renewing the sign-in cookie a request signed in with once it is older than a day: the
 * response sets it again with a fresh signed expiry, so a browser used within every 400 days stays signed in. Not when
 * the route sets a cookie itself, nor for a token that no longer authenticates.
 */
function rollingCookie(
	key: SignInCookie,
	authenticate: (token: string, context: Context) => P3Principal | undefined,
): HttpWrap {
	return {
		name: "p3.rolling-cookie",
		phase: "headers",
		scope: "all",
		wrap: async (request, next, ctx) => {
			const response = await next(request);
			const sets = Object.keys(response.headers ?? {}).some((name) => name.toLowerCase() === "set-cookie");
			if (ctx.principal === undefined || sets) return response;
			const signed = readSignedCookie(request, key.name, key.secret);
			if (signed?.expires === undefined || signed.expires - Date.now() > SIGN_IN_IDLE_MS - ROLL_MS) return response;
			if (authenticate(signed.value, ctx) === undefined) return response;
			const renewed = signInCookie(signed.value, request, key);
			return { ...response, headers: { ...response.headers, "Set-Cookie": renewed } };
		},
	};
}
