// Share links, guests and their grants as tables of the server's Chord store (`Shares`' own). Links and grants belong
// to a session (a `host(Session)` column, decision "Documents and table rows can belong to a host"), so a session's
// export, import and delete carry them; a guest is a person across sessions and belongs to none. Every write is one
// transaction of `Shares`; the reads before a write run inside it. Session state (archived) is checked by the caller.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	type Context,
	columnBool,
	columnInt,
	columnOpt,
	columnStr,
	defineTable,
	eq,
	hostColumn,
	query,
	type RowOf,
	Session,
	type Table,
	type TableOf,
	type Tx,
} from "@p2/app/v1";
import type { ShareLink, ShareMode } from "./contract.ts";

const MODES: readonly ShareMode[] = ["view", "full"];
const MAX_GUESTS_PER_LINK = 1000;
/** The most rows a page of reads takes; links, guests and grants are few per server. */
const PAGE = 1000;
const hash = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/** A session's links: at most one per mode. */
export const LinkRows = defineTable("links", {
	version: 1,
	columns: { session: hostColumn(Session), mode: columnStr(), id: columnStr(), token: columnStr() },
	key: ["session", "mode"],
	indexes: { by_token: ["token"], by_id: ["id"] },
});

/**
 * A guest: a browser that joined through links (`secretHash` of its cookie), or a person the owner shared with by
 * email (`email`, normalized; Radius authenticates them). Never both.
 */
export const GuestRows = defineTable("guests", {
	version: 1,
	columns: {
		id: columnStr(),
		name: columnStr(),
		secretHash: columnOpt(columnStr()),
		email: columnOpt(columnStr()),
		revision: columnInt(),
		lastSeen: columnInt(),
	},
	key: ["id"],
	indexes: { by_name: ["name"] },
});

/** What one guest may do in one session. `linkId` is the link it joined through; absent when shared by email. */
export const GrantRows = defineTable("grants", {
	version: 1,
	columns: {
		session: hostColumn(Session),
		guest: columnStr(),
		mode: columnStr(),
		linkId: columnOpt(columnStr()),
		removed: columnBool(),
		grantedAt: columnInt(),
	},
	key: ["session", "guest"],
	indexes: { by_guest: ["guest"] },
});

type LinkTable = TableOf<typeof LinkRows>;
type GuestTable = TableOf<typeof GuestRows>;
type GrantTable = TableOf<typeof GrantRows>;
type RowsOf<T> = T extends Table<infer C, readonly string[]> ? RowOf<C> : never;
export type LinkStored = RowsOf<LinkTable>;
export type GuestStored = RowsOf<GuestTable>;
export type GrantStored = RowsOf<GrantTable>;

/** A guest as callers read it. */
export type GuestRow = {
	readonly id: string;
	readonly name: string;
	readonly email: string | null;
	readonly revision: number;
};

/** What one guest may do in one session. `linkId` is the link it joined through; null when shared by email. */
export type GrantRow = {
	readonly session: string;
	readonly mode: ShareMode;
	readonly linkId: string | null;
	readonly removed: boolean;
	readonly grantedAt: number;
};

/** A session shared with a person by email; `name` is their email as the owner wrote it. */
export type PersonRow = {
	readonly id: string;
	readonly name: string;
	readonly session: string;
	readonly mode: ShareMode;
};

/** A grant to a person by email that is not removed: the email (normalized) and the session. */
export type EmailGrant = { readonly email: string; readonly session: string };

/** The emails of `grants` on sessions `open` accepts, each once, sorted. */
export function openEmails(grants: readonly EmailGrant[], open: (session: string) => boolean): string[] {
	return [...new Set(grants.filter((grant) => open(grant.session)).map((grant) => grant.email))].sort();
}

/** Thrown for join failures the guest may see. */
export class JoinError extends Error {}

/** A stored mode (written only as `ShareMode`). */
function modeOf(mode: string): ShareMode {
	if (mode === "view" || mode === "full") return mode;
	throw new Error(`Unknown share mode ${JSON.stringify(mode)}`);
}

const guestOf = (row: GuestStored): GuestRow => ({
	id: row.id,
	name: row.name,
	email: row.email ?? null,
	revision: row.revision,
});

const grantOf = (row: GrantStored): GrantRow => ({
	session: row.session.params.id,
	mode: modeOf(row.mode),
	linkId: row.linkId ?? null,
	removed: row.removed,
	grantedAt: row.grantedAt,
});

/** The links of `rows`, by session and then mode (view first). */
export function sortedLinks(rows: readonly LinkStored[]): ShareLink[] {
	return rows
		.map((row) => ({ id: row.id, session: row.session.params.id, mode: modeOf(row.mode), token: row.token }))
		.sort((a, b) => a.session.localeCompare(b.session) || MODES.indexOf(a.mode) - MODES.indexOf(b.mode));
}

/** The people of `grants` (shared by email, not removed) with their guests, by name. */
export function peopleOf(grants: readonly GrantStored[], guests: ReadonlyMap<string, GuestStored>): PersonRow[] {
	return grants
		.flatMap((grant) => {
			const guest = guests.get(grant.guest);
			if (grant.removed || guest?.email === undefined) return [];
			return [{ id: guest.id, name: guest.name, session: grant.session.params.id, mode: modeOf(grant.mode) }];
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The email grants of `grants` (shared by email, not removed). */
export function emailGrantsOf(grants: readonly GrantStored[], guests: ReadonlyMap<string, GuestStored>): EmailGrant[] {
	return grants.flatMap((grant) => {
		const email = guests.get(grant.guest)?.email;
		return grant.removed || email === undefined ? [] : [{ email, session: grant.session.params.id }];
	});
}

/** The share tables of `Shares` and its transactions. */
export type ShareTables = {
	readonly links: LinkTable;
	readonly guests: GuestTable;
	readonly grants: GrantTable;
	readonly tx: <R>(fn: (tx: Tx) => R | Promise<R>, context: Context) => Promise<R>;
};

/** The share store's reads and writes over `tables`. */
export class ShareStore {
	readonly #t: ShareTables;

	constructor(tables: ShareTables) {
		this.#t = tables;
	}

	async linkByToken(token: string, context: Context): Promise<ShareLink | undefined> {
		if (!/^[\w-]{43}$/.test(token)) return undefined;
		const { items } = await this.#t.links.page(
			query(LinkRows).where((row) => eq(row.token, token)),
			1,
			context,
		);
		return sortedLinks(items)[0];
	}

	async guest(id: string, context: Context): Promise<GuestRow | undefined> {
		const row = await this.#t.guests.get({ id }, context);
		return row === undefined ? undefined : guestOf(row);
	}

	/** The guest of a cookie value `<id>.<secret>` whose secret matches. */
	async guestOfCookie(cookie: string, context: Context): Promise<GuestRow | undefined> {
		const [id, secret] = cookie.split(".");
		if (!id || !secret || secret.length !== 64) return undefined;
		const row = await this.#t.guests.get({ id }, context);
		return row !== undefined && row.secretHash === hash(secret) ? guestOf(row) : undefined;
	}

	/** The guest of a normalized email. */
	async guestOfEmail(email: string, context: Context): Promise<GuestRow | undefined> {
		for await (const row of this.#t.guests.rows(query(GuestRows), context))
			if (row.email === email) return guestOf(row);
		return undefined;
	}

	/** A guest's grants, removed ones included. */
	async grants(id: string, context: Context): Promise<GrantRow[]> {
		const { items } = await this.#t.grants.page(
			query(GrantRows).where((row) => eq(row.guest, id)),
			PAGE,
			context,
		);
		return items.map(grantOf);
	}

	/**
	 * Creates the session's link of `mode`, or replaces it. Replacing ends the grants made through the old link; returns
	 * the guests whose grants ended.
	 */
	link(session: string, mode: ShareMode, reset: boolean, context: Context): Promise<string[]> {
		const key = { session: Session({ id: session }), mode };
		return this.#t.tx(async (tx) => {
			const existing = await tx.get(this.#t.links, key);
			if (existing && !reset) return [];
			let ended: string[] = [];
			if (existing) {
				const { items } = await tx.page(
					this.#t.grants,
					query(GrantRows).where((row) => eq(row.session, key.session)),
					PAGE,
				);
				const through = items.filter((grant) => grant.linkId === existing.id);
				ended = through.map((grant) => grant.guest);
				for (const grant of through) tx.delete(this.#t.grants, { session: grant.session, guest: grant.guest });
				for (const id of ended) await this.#bump(tx, id);
			}
			tx.put(this.#t.links, { ...key, id: randomUUID(), token: randomBytes(32).toString("base64url") });
			return ended;
		}, context);
	}

	/** Blocks a guest's grant of `session`; true if it had one. A removed browser cannot join that session again. */
	remove(session: string, guestId: string, context: Context): Promise<boolean> {
		const key = { session: Session({ id: session }), guest: guestId };
		return this.#t.tx(async (tx) => {
			const grant = await tx.get(this.#t.grants, key);
			if (grant === undefined || grant.removed) return false;
			tx.put(this.#t.grants, { ...grant, removed: true });
			await this.#bump(tx, guestId);
			return true;
		}, context);
	}

	/** Bumps the revision of every guest of `session` (archive, restore); returns their IDs. */
	bump(session: string, context: Context): Promise<string[]> {
		return this.#t.tx(async (tx) => {
			const { items } = await tx.page(
				this.#t.grants,
				query(GrantRows).where((row) => eq(row.session, Session({ id: session }))),
				PAGE,
			);
			const ids = items.map((grant) => grant.guest);
			for (const id of ids) await this.#bump(tx, id);
			return ids;
		}, context);
	}

	/**
	 * Joins `link`: `existing` (the browser's guest, by its cookie) gains the link's session, else a new guest is created
	 * with the cleaned name, made unique ("Alice (2)"), and a cookie. Joining a session again takes the link's mode.
	 * `changed` says whether an existing guest's grants changed (its revision was bumped).
	 */
	join(
		link: ShareLink,
		requestedName: string,
		existing: GuestRow | undefined,
		context: Context,
	): Promise<{ guest: string; cookie?: string; changed: boolean }> {
		const session = Session({ id: link.session });
		return this.#t.tx(async (tx) => {
			const grant = existing && (await tx.get(this.#t.grants, { session, guest: existing.id }));
			if (grant?.removed) throw new JoinError("You were removed from this session");
			if (existing && grant && grant.mode === link.mode && grant.linkId === link.id)
				return { guest: existing.id, changed: false };
			const { items } = await tx.page(
				this.#t.grants,
				query(GrantRows).where((row) => eq(row.session, session)),
				PAGE + MAX_GUESTS_PER_LINK,
			);
			if (items.filter((each) => each.linkId === link.id).length >= MAX_GUESTS_PER_LINK)
				throw new JoinError("Guest limit reached");
			let id = existing?.id;
			let cookie: string | undefined;
			if (id === undefined) {
				id = randomUUID();
				const secret = randomBytes(32).toString("hex");
				tx.put(this.#t.guests, {
					id,
					name: await this.#uniqueName(tx, requestedName),
					secretHash: hash(secret),
					revision: 1,
					lastSeen: Date.now(),
				});
				cookie = `${id}.${secret}`;
			}
			this.#grant(tx, id, link.session, link.mode, link.id);
			if (existing) await this.#bump(tx, id);
			return { guest: id, ...(cookie ? { cookie } : {}), changed: existing !== undefined };
		}, context);
	}

	/**
	 * Shares `session` with the person of `email` (normalized; `name` is how the owner wrote it), creating their guest
	 * first, and gives a removed person access again. Returns the guest and whether an existing guest changed.
	 */
	share(
		session: string,
		email: string,
		name: string,
		mode: ShareMode,
		context: Context,
	): Promise<{ guest: string; changed: boolean }> {
		return this.#t.tx(async (tx) => {
			const existing = await this.#guestOfEmail(tx, email);
			const id = existing?.id ?? randomUUID();
			if (!existing) tx.put(this.#t.guests, { id, name, email, revision: 1, lastSeen: 0 });
			this.#grant(tx, id, session, mode, null);
			if (existing) await this.#bump(tx, id);
			return { guest: id, changed: existing !== undefined };
		}, context);
	}

	seen(id: string, context: Context): Promise<void> {
		return this.#t.tx(async (tx) => {
			const guest = await tx.get(this.#t.guests, { id });
			if (guest !== undefined) tx.put(this.#t.guests, { ...guest, lastSeen: Date.now() });
		}, context);
	}

	#grant(tx: Tx, guest: string, session: string, mode: ShareMode, linkId: string | null): void {
		tx.put(this.#t.grants, {
			session: Session({ id: session }),
			guest,
			mode,
			...(linkId === null ? {} : { linkId }),
			removed: false,
			grantedAt: Date.now(),
		});
	}

	async #bump(tx: Tx, id: string): Promise<void> {
		const guest = await tx.get(this.#t.guests, { id });
		if (guest !== undefined) tx.put(this.#t.guests, { ...guest, revision: guest.revision + 1 });
	}

	async #guestOfEmail(tx: Tx, email: string): Promise<GuestStored | undefined> {
		for await (const row of tx.rows(this.#t.guests, query(GuestRows))) if (row.email === email) return row;
		return undefined;
	}

	async #uniqueName(tx: Tx, requested: string): Promise<string> {
		const name = requested
			.normalize("NFKC")
			.replace(/[\p{C}<>]/gu, "")
			.trim()
			.slice(0, 40);
		if (!name) throw new JoinError("Choose a guest name");
		let count = 0;
		for await (const row of tx.rows(this.#t.guests, query(GuestRows)))
			if (row.name === name || (row.name.startsWith(`${name} (`) && row.name.endsWith(")"))) count++;
		return count ? `${name} (${count + 1})` : name;
	}
}
