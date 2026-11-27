// The sign-ins: `SignIns` (one row each in the server's store, by id and by person, expiring after 400 days unused;
// before version 2 they lived in one document, moved into the table once at the start), the authenticator (a bearer
// token first, else the signed sign-in cookie, which lives 400 days from its issue: the stopgap renews none), and the
// hook that closes the open links of a sign-in that ends (and every link `SignIns` tracked, once it ends); tokens are
// random, kept only as their SHA-256 hashes, compared in constant time (the owner link's too).

import {
	BACKGROUND_CONTEXT,
	type Context,
	defineState,
	defineTable,
	eq,
	type FacetHost,
	type HandleOf,
	int,
	json,
	map,
	num,
	obj,
	oneOf,
	P3Principal,
	query,
	reportError,
	type StoreSelf,
	str,
	type TableOf,
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
 * One row per sign-in: its secret's hash, label, kind and principal, when it was made and last used, and the person it
 * signs in (a person's principal's id; `""` for another principal), by which `rows.ofPerson` finds it.
 */
const SignInsTable = defineTable("sign-in.sign-ins", {
	version: 1,
	columns: {
		id: str(),
		hash: str(),
		label: str(),
		kind: json(oneOf("browser", "device"), { version: 1 }),
		principal: json(P3Principal, { version: 1 }),
		person: str(),
		created: int(),
		lastUsed: int(),
	},
	key: ["id"],
	indexes: { by_person: ["person", "created"] },
});

/**
 * The cookie's key, made once per Pi: its id names the cookie (a browser shares cookies between the ports of one host,
 * so two Pis on a machine need two names), its secret signs it. The key starts empty and the first issue writes it: no
 * cookie exists before, and a value only `initial` made is never stored (a random initial key would be a new one at
 * every start: every browser signed out). `signIns`: where version 1 of `SignIns` kept the sign-ins, moved into
 * `SignInsTable` once at the start and emptied (the schema stays as stored, decision 125). Exported for that move's
 * test.
 */
export const SignInsDocument = defineState("p3.sign-ins", {
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

/** What the authenticator needs of a sign-in, kept in memory: its hash, principal and last use. */
type Known = { readonly hash: string; readonly principal: P3Principal; lastUsed: number };

/** Serves `SignIns` on `host` (a host-lifetime object: its contributions live from the load on). */
export function serveSignIns(host: FacetHost<P3Principal>): void {
	host.serve(SignIns, (_params, self) => {
		const document = self.state(SignInsDocument);
		const table = self.table(SignInsTable);
		/** The cookie's key, `undefined` until the first issue wrote it: no cookie is read before. */
		const key = (): Key | undefined => {
			const { id, secret } = document.value.cookie;
			return id === "" ? undefined : { name: `p3-${id}`, secret };
		};
		const links = new SignInLinks();
		// Every sign-in by id, as the table has it (this object is its one writer): the authenticator and the link hook
		// answer without a read (the hook cannot wait). Loaded before anyone is authenticated, after the sign-ins version 1
		// kept in the document moved into the table.
		const known = new Map<string, Known>();
		self.open(
			async (ctx) => {
				await moveDocumentSignIns(self, document, table, ctx);
				await self.tx(async (tx) => {
					for await (const { id, hash, principal, lastUsed } of tx.rows(table, query(SignInsTable)))
						known.set(id, { hash, principal, lastUsed });
					return null;
				}, ctx);
				return null;
			},
			() => {},
		);
		// The next object (a reload's) tracks none of these links, so it could never close them: they end with this one,
		// and their clients sign in again.
		self.onLive(async (ctx) => {
			await untilAborted(ctx);
			links.closeAll();
		});
		/** Ends sign-in `id`: its row deleted, then its open links closed. */
		const end = async (id: string, context: Context): Promise<null> => {
			await self.tx(async (tx) => {
				tx.delete(table, { id });
				return null;
			}, context);
			known.delete(id);
			links.close(id);
			return null;
		};
		/** Writes sign-in `id`'s last use `now` (not awaited by the use). */
		const touch = (id: string, now: number, context: Context): Promise<null> =>
			self.tx(async (tx) => {
				if ((await tx.get(table, { id })) !== undefined) tx.update(table, { id }, { lastUsed: now });
				return null;
			}, context);
		const authenticate = (token: string, context: Context) => authenticated(known, token, end, touch, context);
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
			rows: self.queries(
				table,
				{
					map: ({ id, label, kind, principal, created, lastUsed }) => ({
						id,
						label,
						kind,
						principal,
						created,
						lastUsed,
					}),
				},
				{
					// Index `by_person`: one person's, in the order they were made.
					ofPerson: ({ person }: { person: string }) =>
						query(SignInsTable)
							.where((r) => eq(r.person, person))
							.orderBy((r) => r.created, "asc"),
					// The key: every sign-in.
					all: (_args: Record<never, never>) => query(SignInsTable),
				},
			),
			issue: async ({ principal, label, kind, secure }, ctx) => {
				const id = newToken(12);
				const secret = newToken(32);
				const now = Date.now();
				if (document.value.cookie.id === "") {
					await document.change((draft) => {
						if (draft.cookie.id === "") draft.cookie = { id: newToken(8), secret: newToken(32) };
					}, ctx);
				}
				const hash = hashToken(secret);
				await self.tx(async (tx) => {
					tx.put(table, rowOf(id, { hash, label, kind, principal, created: now, lastUsed: now }));
					return null;
				}, ctx);
				known.set(id, { hash, principal, lastUsed: now });
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
			revokeOf: async ({ person }, ctx) => {
				const ids = await self.tx(async (tx) => {
					const gone: string[] = [];
					for await (const row of tx.rows(
						table,
						query(SignInsTable).where((r) => eq(r.person, person)),
					))
						gone.push(row.id);
					tx.deleteWhere(table, (r) => eq(r.person, person));
					return gone;
				}, ctx);
				for (const id of ids) {
					known.delete(id);
					links.close(id);
				}
				return null;
			},
		};
	});
}

/** The row of sign-in `id` (its person: a person's principal's id, else `""`). */
function rowOf(
	id: string,
	{
		hash,
		label,
		kind,
		principal,
		created,
		lastUsed,
	}: {
		readonly hash: string;
		readonly label: string;
		readonly kind: "browser" | "device";
		readonly principal: P3Principal;
		readonly created: number;
		readonly lastUsed: number;
	},
) {
	return {
		id,
		hash,
		label,
		kind,
		principal,
		person: principal.kind === "person" ? principal.id : "",
		created,
		lastUsed,
	};
}

/**
 * Moves the sign-ins version 1 kept in the document into the table (one transaction), then empties the document's:
 * once per Pi; a crash between the two moves them again (a put by id writes the same row).
 */
async function moveDocumentSignIns(
	self: StoreSelf<P3Principal>,
	document: HandleOf<typeof SignInsDocument>,
	table: TableOf<typeof SignInsTable>,
	context: Context,
): Promise<null> {
	const kept = Object.entries(document.value.signIns);
	if (kept.length === 0) return null;
	await self.tx(async (tx) => {
		for (const [id, signIn] of kept) tx.put(table, rowOf(id, signIn));
		return null;
	}, context);
	await document.change((draft) => {
		draft.signIns = {};
	}, context);
	return null;
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
	known: Map<string, Known>,
	token: string,
	end: (id: string, context: Context) => Promise<null>,
	touch: (id: string, now: number, context: Context) => Promise<null>,
	context: Context,
): { readonly id: string; readonly principal: P3Principal } | undefined {
	const id = signInOf(token);
	// A trust boundary: `id` is the client's; the map finds only a sign-in of that id.
	const signIn = id === undefined ? undefined : known.get(id);
	if (id === undefined || signIn === undefined || !matchesHash(token.slice(id.length + 1), signIn.hash))
		return undefined;
	const now = Date.now();
	if (now - signIn.lastUsed > SIGN_IN_IDLE_MS) {
		void end(id, context).catch((error: unknown) => reportError(`p3 sign-in: ${id}: ending it`, error, context));
		return undefined;
	}
	if (now - signIn.lastUsed > TOUCH_MS) {
		signIn.lastUsed = now;
		void touch(id, now, context).catch((error: unknown) =>
			reportError(`p3 sign-in: ${id}: its last use`, error, context),
		);
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
