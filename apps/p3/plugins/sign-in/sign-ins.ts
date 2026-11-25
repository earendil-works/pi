// The sign-ins: `SignIns` (persisted in the server's store, expiring after 400 days unused), the authenticator (a
// bearer token first, else the signed sign-in cookie), the wrap renewing a browser's cookie, and the hook that closes
// the open links of a sign-in that ends.

import {
	type Context,
	defineState,
	type FacetHost,
	type HandleOf,
	map,
	num,
	obj,
	oneOf,
	P3Principal,
	str,
} from "@earendil-works/p3/v1";
import {
	Authenticators,
	cookie,
	Http,
	type HttpRequest,
	type HttpWrap,
	LinkOpened,
	type Provenance,
	readCookie,
	readSignedCookie,
} from "@earendil-works/p3/v1/server";
import { SignIns } from "./contract.ts";
import { hashToken, matchesHash, newToken } from "./secrets.ts";

/** How long a sign-in lives unused: 400 days, as its cookie. */
const SIGN_IN_IDLE_MS = 400 * 24 * 60 * 60_000;

/** How often a sign-in's `lastUsed` is written at most: once a minute. */
const TOUCH_MS = 60_000;

/** How old a sign-in cookie gets before a response renews it: a day. */
const ROLL_MS = 24 * 60 * 60_000;

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

/**
 * The cookie's key, made once per Pi: its id names the cookie (a browser shares cookies between the ports of one host,
 * so two Pis on a machine need two names), its secret signs it.
 */
const CookieKey = defineState("p3.sign-in-cookie", {
	schema: obj({ id: str(), secret: str() }),
	version: 1,
	initial: () => ({ id: newToken(8), secret: newToken(32) }),
	persist: true,
	checkpointWhen: () => true,
});

/** The sign-in cookie's name and secret. */
type Key = { readonly name: string; readonly secret: string };

/** Serves `SignIns` on `host` (a host-lifetime object: its contributions live from the load on). */
export function serveSignIns(host: FacetHost<P3Principal>): void {
	const links = new SignInLinks();
	host.serve(SignIns, (_params, self) => {
		const document = self.state(SignInsDocument);
		const stored = self.state(CookieKey);
		const key = (): Key => ({ name: `p3-${stored.value.id}`, secret: stored.value.secret });
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
			const token = requestToken(request, key());
			const principal = token === undefined ? undefined : authenticate(token, context);
			if (principal !== undefined) links.signedIn(request, signInOf(token!)!);
			return principal;
		});
		self.contribute(Http, { wraps: [rollingCookie(key, authenticate)] });
		self.contribute(LinkOpened, (request, close) => links.opened(request, close));
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
				return { id, token, cookie: signInCookie(token, { provenance }, key()) };
			},
			verify: async (token, ctx) => authenticate(token, ctx) ?? null,
			revoke: end,
		};
	});
}

/** The open links of each sign-in, by its id; and which sign-in each request authenticated with. */
class SignInLinks {
	readonly #closes = new Map<string, Set<() => void>>();
	readonly #requests = new WeakMap<HttpRequest, string>();
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
	 * A link opened for `request`; `close` ends it. A sign-in that ended between the request's authentication and now
	 * has its link closed at once. Returns what to call when the link closed.
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

	/** Closes every open link of sign-in `id`. */
	close(id: string): void {
		for (const close of this.#closes.get(id) ?? []) close();
	}
}

/**
 * The principal `token` authenticates as, or `undefined`. It touches the sign-in it names (at most once a minute), or
 * ends it when it was unused too long; neither is awaited.
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

/** The token `request` carries: its bearer token first, else its sign-in cookie. */
function requestToken(request: HttpRequest, key: Key): string | undefined {
	const header = request.headers.get("authorization");
	const bearer = header === null ? null : /^Bearer\s+(\S+)$/i.exec(header);
	return bearer?.[1] ?? readCookie(request, key.name, key.secret);
}

/** The sign-in cookie carrying `token` for a browser of `request`'s provenance: it lives 400 days unused. */
function signInCookie(token: string, request: Pick<HttpRequest, "provenance">, key: Key): string {
	return cookie(key.name, token, { secret: key.secret, request, maxAge: SIGN_IN_IDLE_MS / 1000 });
}

/**
 * The wrap renewing the sign-in cookie a request signed in with once it is older than a day, so a browser used within
 * every 400 days stays signed in. Not when the route sets a cookie itself, nor for a token that no longer authenticates.
 */
function rollingCookie(
	key: () => Key,
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
			const { name, secret } = key();
			const signed = readSignedCookie(request, name, secret);
			if (signed?.expires === undefined || signed.expires - Date.now() > SIGN_IN_IDLE_MS - ROLL_MS) return response;
			if (authenticate(signed.value, ctx) === undefined) return response;
			const renewed = signInCookie(signed.value, request, key());
			return { ...response, headers: { ...response.headers, "Set-Cookie": renewed } };
		},
	};
}
