// The sign-ins: `SignIns` (persisted in the server's store, expiring after 400 days unused), the authenticator (a
// bearer token first, else the signed sign-in cookie, which lives 400 days from its issue: the stopgap renews none),
// and the hook that closes the open links of a sign-in that ends (and every link `SignIns` tracked, once it ends);
// tokens are random, kept only as their SHA-256 hashes, compared in constant time (the owner link's too).

import {
	BACKGROUND_CONTEXT,
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
	type HttpRequest,
	hashToken,
	LinkOpened,
	matchesHash,
	newToken,
	type Provenance,
	readCookie,
} from "@earendil-works/p3/v1/server";
import { SignIns } from "./contract.ts";

/** How long a sign-in lives unused, and its cookie from its issue: 400 days. */
const SIGN_IN_IDLE_MS = 400 * 24 * 60 * 60_000;

/** How often a sign-in's `lastUsed` is written at most: once a minute. */
const TOUCH_MS = 60_000;

/**
 * The stored sign-ins: by id, each with its secret's hash and its principal; and the cookie's key, made once per Pi:
 * its id names the cookie (a browser shares cookies between the ports of one host, so two Pis on a machine need two
 * names), its secret signs it. The key starts empty and the first issue writes it: no cookie exists before, and a value
 * only `initial` made is never stored (a random initial key would be a new one at every start: every browser signed
 * out).
 */
const SignInsDocument = defineState("p3.sign-ins", {
	schema: obj({
		cookie: obj({ id: str(), secret: str() }),
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
	initial: () => ({ cookie: { id: "", secret: "" }, signIns: {} }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
});

/** The sign-in cookie's name and secret. */
type Key = { readonly name: string; readonly secret: string };

/** Serves `SignIns` on `host` (a host-lifetime object: its contributions live from the load on). */
export function serveSignIns(host: FacetHost<P3Principal>): void {
	host.serve(SignIns, (_params, self) => {
		const document = self.state(SignInsDocument);
		/** The cookie's key, `undefined` until the first issue wrote it: no cookie is read before. */
		const key = (): Key | undefined => {
			const { id, secret } = document.value.cookie;
			return id === "" ? undefined : { name: `p3-${id}`, secret };
		};
		const links = new SignInLinks();
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
			return token === undefined ? undefined : authenticate(token, context)?.principal;
		});
		// The link's request is checked again here, not remembered from its authentication: a reload of this plugin
		// between the two would leave the link to an object that never saw the request, and a revoke would miss it. A
		// sign-in that ended in between closes its link at once.
		self.contribute(LinkOpened, (request, close) => {
			const token = requestToken(request, key());
			if (token === undefined) return undefined;
			const signIn = authenticate(token, BACKGROUND_CONTEXT);
			if (signIn === undefined) close();
			return links.opened(signIn?.id, close);
		});
		return {
			list: self.derive([document], ([value]) =>
				Object.entries(value.signIns).map(([id, { hash: _, ...shown }]) => ({ id, ...shown })),
			),
			issue: async ({ principal, label, kind, secure }, ctx) => {
				const id = newToken(12);
				const secret = newToken(32);
				const now = Date.now();
				await document.change((draft) => {
					if (draft.cookie.id === "") draft.cookie = { id: newToken(8), secret: newToken(32) };
					draft.signIns[id] = { hash: hashToken(secret), label, kind, principal, created: now, lastUsed: now };
				}, ctx);
				const token = `${id}.${secret}`;
				// Written by the change above, or before.
				const { name, secret: signing } = key()!;
				// Only whether the browser is remote matters to the cookie (`Secure`).
				const provenance: Provenance = secure === true ? { kind: "remote", host: "" } : { kind: "local" };
				const signed = cookie(name, token, {
					secret: signing,
					request: { provenance },
					maxAge: SIGN_IN_IDLE_MS / 1000,
				});
				return { id, token, cookie: signed };
			},
			verify: async (token, ctx) => authenticate(token, ctx)?.principal ?? null,
			revoke: end,
		};
	});
}

/** The open links of each sign-in, by its id. */
class SignInLinks {
	readonly #closes = new Map<string, Set<() => void>>();

	/** A link of sign-in `id` (none: no sign-in's) opened; `close` ends it. Returns what to call when the link closed. */
	opened(id: string | undefined, close: () => void): (() => void) | undefined {
		if (id === undefined) return undefined;
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
 * The sign-in `token` authenticates with (its id and principal), or `undefined`. It touches that sign-in (at most once
 * a minute), or ends it when it was unused too long; neither is awaited.
 */
function authenticated(
	document: HandleOf<typeof SignInsDocument>,
	token: string,
	end: (id: string, context: Context) => Promise<null>,
	context: Context,
): { readonly id: string; readonly principal: P3Principal } | undefined {
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
	return { id, principal: signIn.principal };
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
