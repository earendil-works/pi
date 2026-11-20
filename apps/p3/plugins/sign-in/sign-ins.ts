// The sign-ins: `SignIns` (persisted in the server's store, expiring after 400 days unused), the authenticator (a
// bearer token first, else the signed sign-in cookie), the wrap renewing a browser's cookie, and the hook that closes
// the open links of a sign-in that ends (and every link `SignIns` tracked, once it ends).

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
	reportError,
	str,
	untilAborted,
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
 * so two Pis on a machine need two names), its secret signs it. It starts empty and `SignIns` writes it once: a value
 * only `initial` made is never stored, so a random initial key would be a new one at every start (every browser signed
 * out).
 */
const CookieKey = defineState("p3.sign-in-cookie", {
	schema: obj({ id: str(), secret: str() }),
	version: 1,
	initial: () => ({ id: "", secret: "" }),
	persist: true,
	checkpointWhen: () => true,
});

/** The sign-in cookie's name and secret. */
type Key = { readonly name: string; readonly secret: string };

/** Serves `SignIns` on `host` (a host-lifetime object: its contributions live from the load on). */
export function serveSignIns(host: FacetHost<P3Principal>): void {
	host.serve(SignIns, (_params, self) => {
		const document = self.state(SignInsDocument);
		const stored = self.state(CookieKey);
		/** The cookie's key, `undefined` until it is written: no cookie is read or made without one. */
		const key = (): Key | undefined =>
			stored.value.id === "" ? undefined : { name: `p3-${stored.value.id}`, secret: stored.value.secret };
		// Resolved once the key is written (a failed write is retried: the routine restarts after a backoff).
		const keyed = Promise.withResolvers<Key>();
		self.onLive(async (ctx) => {
			if (stored.value.id === "") {
				await stored.change((draft) => {
					draft.id = newToken(8);
					draft.secret = newToken(32);
				}, ctx);
			}
			// Written now, or found written.
			keyed.resolve(key()!);
		});
		const links = new SignInLinks((id) => {
			const signIns = document.value.signIns;
			return Object.hasOwn(signIns, id) && Date.now() - signIns[id]!.lastUsed <= SIGN_IN_IDLE_MS;
		});
		// The next object (a reload's) tracks none of these links, so it could never close them: they end with this one,
		// and their clients sign in again.
		self.onLive(async (ctx) => {
			await untilAborted(ctx);
			links.closeAll();
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
				const cookieKey = await keyed.promise;
				// Only whether the browser is remote matters to the cookie (`Secure`).
				const provenance: Provenance = secure === true ? { kind: "remote", host: "" } : { kind: "local" };
				return { id, token, cookie: signInCookie(token, { provenance }, cookieKey) };
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
	readonly #live: (id: string) => boolean;

	/** One `SignIns` object's links: `live` says whether a sign-in exists and has not expired (read as a link opens). */
	constructor(live: (id: string) => boolean) {
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

	/** Closes every open link of every sign-in. */
	closeAll(): void {
		for (const id of [...this.#closes.keys()]) this.close(id);
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
		void end(id, context).catch((error: unknown) => reportError(`p3 sign-in: ${id}: ending it`, error, context));
		return undefined;
	}
	if (now - signIn.lastUsed > TOUCH_MS) {
		const touch = document.change((draft) => {
			if (Object.hasOwn(draft.signIns, id)) draft.signIns[id]!.lastUsed = now;
		}, context);
		void touch.catch((error: unknown) => reportError(`p3 sign-in: ${id}: its last use`, error, context));
	}
	return signIn.principal;
}

/** The id of the sign-in a token `<id>.<secret>` names, or `undefined` for a text that is no token. */
function signInOf(token: string): string | undefined {
	const dot = token.indexOf(".");
	return dot > 0 ? token.slice(0, dot) : undefined;
}

/** The token `request` carries: its bearer token first, else its sign-in cookie (none before the key is written). */
function requestToken(request: HttpRequest, key: Key | undefined): string | undefined {
	const header = request.headers.get("authorization");
	const bearer = header === null ? null : /^Bearer\s+(\S+)$/i.exec(header);
	return bearer?.[1] ?? (key === undefined ? undefined : readCookie(request, key.name, key.secret));
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
	key: () => Key | undefined,
	authenticate: (token: string, context: Context) => P3Principal | undefined,
): HttpWrap {
	return {
		name: "p3.rolling-cookie",
		phase: "headers",
		scope: "all",
		wrap: async (request, next, ctx) => {
			const response = await next(request);
			const sets = Object.keys(response.headers ?? {}).some((name) => name.toLowerCase() === "set-cookie");
			const current = key();
			if (ctx.principal === undefined || sets || current === undefined) return response;
			const signed = readSignedCookie(request, current.name, current.secret);
			if (signed?.expires === undefined || signed.expires - Date.now() > SIGN_IN_IDLE_MS - ROLL_MS) return response;
			if (authenticate(signed.value, ctx) === undefined) return response;
			const renewed = signInCookie(signed.value, request, current);
			return { ...response, headers: { ...response.headers, "Set-Cookie": renewed } };
		},
	};
}
