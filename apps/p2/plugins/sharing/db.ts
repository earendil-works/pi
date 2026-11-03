// Share links, guests and their grants (SQLite). Session state (archived) is checked by the caller.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ShareLink, ShareMode } from "./contract.ts";

/**
 * Version 2 separates who a guest is (`guests`) from what was shared with them (`grants`, one per session), so that one
 * guest can hold several sessions, and adds guests the owner shared with by email. Version 1 had one guest per link.
 */
const SCHEMA_VERSION = 2;
const MODES: readonly ShareMode[] = ["view", "full"];
const MAX_GUESTS_PER_LINK = 1000;
const hash = (secret: string): string => createHash("sha256").update(secret).digest("hex");

const GUESTS = `CREATE TABLE IF NOT EXISTS guests (
	id TEXT PRIMARY KEY, name TEXT NOT NULL,
	secretHash TEXT, email TEXT UNIQUE,
	revision INTEGER NOT NULL DEFAULT 1, lastSeen INTEGER NOT NULL
) STRICT`;
const GRANTS = `CREATE TABLE IF NOT EXISTS grants (
	guest TEXT NOT NULL, session TEXT NOT NULL, mode TEXT NOT NULL, linkId TEXT,
	removed INTEGER NOT NULL DEFAULT 0, grantedAt INTEGER NOT NULL,
	PRIMARY KEY (guest, session)
) STRICT`;

/**
 * A guest: a browser that joined through links (`secretHash` of its cookie), or a person the owner shared with by
 * email (`email`, normalized; Radius authenticates them). Never both.
 */
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

/** Thrown for join failures the guest may see. */
export class JoinError extends Error {}

export class ShareDb {
	readonly #db: DatabaseSync;

	constructor(directory: string) {
		const path = join(directory, "shares.sqlite");
		this.#db = new DatabaseSync(path);
		chmodSync(path, 0o600);
		this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
		const version = Number(this.#db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
		if (version !== 0 && version !== 1 && version !== SCHEMA_VERSION) {
			this.#db.close();
			throw new Error(`Unsupported shares schema: ${version}`);
		}
		this.#transaction(() => {
			this.#db.exec(`
				CREATE TABLE IF NOT EXISTS links (
					id TEXT PRIMARY KEY, session TEXT NOT NULL, mode TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
					UNIQUE(session, mode)
				) STRICT;
				${GRANTS};
			`);
			// Version 1: each guest becomes a guest with one grant, the session of its link.
			if (version === 1)
				this.#db.exec(`
					ALTER TABLE guests RENAME TO guests_v1;
					${GUESTS};
					INSERT INTO guests(id,name,secretHash,revision,lastSeen)
						SELECT id,name,secretHash,revision,lastSeen FROM guests_v1;
					INSERT INTO grants(guest,session,mode,linkId,removed,grantedAt)
						SELECT guests_v1.id,links.session,links.mode,links.id,guests_v1.removed,guests_v1.lastSeen
						FROM guests_v1 JOIN links ON links.id=guests_v1.linkId;
					DROP TABLE guests_v1;
				`);
			else this.#db.exec(GUESTS);
			this.#db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
		});
	}

	#transaction<T>(fn: () => T): T {
		this.#db.exec("BEGIN");
		try {
			const result = fn();
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	links(): ShareLink[] {
		return this.#db
			.prepare("SELECT id,session,mode,token FROM links")
			.all()
			.map((row) => ({
				id: String(row.id),
				session: String(row.session),
				mode: row.mode as ShareMode,
				token: String(row.token),
			}))
			.sort((a, b) => a.session.localeCompare(b.session) || MODES.indexOf(a.mode) - MODES.indexOf(b.mode));
	}

	linkByToken(token: string): ShareLink | undefined {
		if (!/^[\w-]{43}$/.test(token)) return undefined;
		return this.links().find((link) => link.token === token);
	}

	/**
	 * Creates the session's link of `mode`, or replaces it. Replacing ends the grants made through the old link; returns
	 * the guests whose grants ended.
	 */
	link(session: string, mode: ShareMode, reset: boolean): string[] {
		const existing = this.links().find((link) => link.session === session && link.mode === mode);
		if (existing && !reset) return [];
		return this.#transaction(() => {
			let ended: string[] = [];
			if (existing) {
				ended = this.#db
					.prepare("SELECT guest FROM grants WHERE linkId=?")
					.all(existing.id)
					.map((row) => String(row.guest));
				this.#db.prepare("DELETE FROM grants WHERE linkId=?").run(existing.id);
				this.#db.prepare("DELETE FROM links WHERE id=?").run(existing.id);
				for (const id of ended) this.#bump(id);
			}
			this.#db
				.prepare("INSERT INTO links(id,session,mode,token) VALUES(?,?,?,?)")
				.run(randomUUID(), session, mode, randomBytes(32).toString("base64url"));
			return ended;
		});
	}

	guest(id: string): GuestRow | undefined {
		const row = this.#db.prepare("SELECT id,name,email,revision FROM guests WHERE id=?").get(id);
		if (!row) return undefined;
		return {
			id: String(row.id),
			name: String(row.name),
			email: row.email === null ? null : String(row.email),
			revision: Number(row.revision),
		};
	}

	/** The guest of a cookie value `<id>.<secret>` whose secret matches. */
	guestOfCookie(cookie: string): GuestRow | undefined {
		const [id, secret] = cookie.split(".");
		if (!id || !secret || secret.length !== 64) return undefined;
		const row = this.#db.prepare("SELECT secretHash FROM guests WHERE id=?").get(id);
		return row?.secretHash === hash(secret) ? this.guest(id) : undefined;
	}

	/** The guest of a normalized email. */
	guestOfEmail(email: string): GuestRow | undefined {
		const row = this.#db.prepare("SELECT id FROM guests WHERE email=?").get(email);
		return row ? this.guest(String(row.id)) : undefined;
	}

	/** A guest's grants, removed ones included. */
	grants(id: string): GrantRow[] {
		return this.#db
			.prepare("SELECT session,mode,linkId,removed,grantedAt FROM grants WHERE guest=?")
			.all(id)
			.map((row) => ({
				session: String(row.session),
				mode: row.mode as ShareMode,
				linkId: row.linkId === null ? null : String(row.linkId),
				removed: row.removed === 1,
				grantedAt: Number(row.grantedAt),
			}));
	}

	/** Blocks a guest's grant of `session`; true if it had one. A removed browser cannot join that session again. */
	remove(session: string, guestId: string): boolean {
		return this.#transaction(() => {
			const result = this.#db
				.prepare("UPDATE grants SET removed=1 WHERE guest=? AND session=? AND removed=0")
				.run(guestId, session);
			if (Number(result.changes) === 0) return false;
			this.#bump(guestId);
			return true;
		});
	}

	/** Bumps the revision of every guest of `session` (archive, restore); returns their IDs. */
	bump(session: string): string[] {
		return this.#transaction(() => {
			const ids = this.#db
				.prepare("SELECT guest FROM grants WHERE session=?")
				.all(session)
				.map((row) => String(row.guest));
			for (const id of ids) this.#bump(id);
			return ids;
		});
	}

	/**
	 * Joins `link`: `existing` (the browser's guest, by its cookie) gains the link's session, else a new guest is created
	 * with the cleaned name, made unique ("Alice (2)"), and a cookie. Joining a session again takes the link's mode.
	 * `changed` says whether an existing guest's grants changed (its revision was bumped).
	 */
	join(
		link: ShareLink,
		requestedName: string,
		existing?: GuestRow,
	): { guest: string; cookie?: string; changed: boolean } {
		return this.#transaction(() => {
			const grant = existing && this.grants(existing.id).find((entry) => entry.session === link.session);
			if (grant?.removed) throw new JoinError("You were removed from this session");
			if (existing && grant && grant.mode === link.mode && grant.linkId === link.id)
				return { guest: existing.id, changed: false };
			if (
				Number(this.#db.prepare("SELECT count(*) AS n FROM grants WHERE linkId=?").get(link.id)?.n) >=
				MAX_GUESTS_PER_LINK
			)
				throw new JoinError("Guest limit reached");
			let id = existing?.id;
			let cookie: string | undefined;
			if (id === undefined) {
				id = randomUUID();
				const secret = randomBytes(32).toString("hex");
				this.#db
					.prepare("INSERT INTO guests(id,name,secretHash,lastSeen) VALUES(?,?,?,?)")
					.run(id, this.#uniqueName(requestedName), hash(secret), Date.now());
				cookie = `${id}.${secret}`;
			}
			this.#grant(id, link.session, link.mode, link.id);
			if (existing) this.#bump(id);
			return { guest: id, ...(cookie ? { cookie } : {}), changed: existing !== undefined };
		});
	}

	/**
	 * Shares `session` with the person of `email` (normalized; `name` is how the owner wrote it), creating their guest
	 * first, and gives a removed person access again. Returns the guest and whether an existing guest changed.
	 */
	share(session: string, email: string, name: string, mode: ShareMode): { guest: string; changed: boolean } {
		return this.#transaction(() => {
			const existing = this.guestOfEmail(email);
			const id = existing?.id ?? randomUUID();
			if (!existing)
				this.#db.prepare("INSERT INTO guests(id,name,email,lastSeen) VALUES(?,?,?,?)").run(id, name, email, 0);
			this.#grant(id, session, mode, null);
			if (existing) this.#bump(id);
			return { guest: id, changed: existing !== undefined };
		});
	}

	/** Every grant to a person by email that is not removed, by name. */
	people(): PersonRow[] {
		return this.#db
			.prepare(
				"SELECT guests.id,guests.name,grants.session,grants.mode FROM grants JOIN guests ON guests.id=grants.guest WHERE grants.removed=0 AND guests.email IS NOT NULL ORDER BY guests.name",
			)
			.all()
			.map((row) => ({
				id: String(row.id),
				name: String(row.name),
				session: String(row.session),
				mode: row.mode as ShareMode,
			}));
	}

	/** Every email with a grant that is not removed, on a session `open` accepts; sorted. */
	emails(open: (session: string) => boolean): string[] {
		const emails = new Set<string>();
		for (const row of this.#db
			.prepare(
				"SELECT guests.email,grants.session FROM grants JOIN guests ON guests.id=grants.guest WHERE grants.removed=0 AND guests.email IS NOT NULL",
			)
			.all())
			if (open(String(row.session))) emails.add(String(row.email));
		return [...emails].sort();
	}

	seen(id: string): void {
		this.#db.prepare("UPDATE guests SET lastSeen=? WHERE id=?").run(Date.now(), id);
	}

	close(): void {
		this.#db.close();
	}

	#grant(guest: string, session: string, mode: ShareMode, linkId: string | null): void {
		this.#db
			.prepare(
				"INSERT INTO grants(guest,session,mode,linkId,removed,grantedAt) VALUES(?,?,?,?,0,?) ON CONFLICT(guest,session) DO UPDATE SET mode=excluded.mode, linkId=excluded.linkId, removed=0, grantedAt=excluded.grantedAt",
			)
			.run(guest, session, mode, linkId, Date.now());
	}

	#bump(guest: string): void {
		this.#db.prepare("UPDATE guests SET revision=revision+1 WHERE id=?").run(guest);
	}

	#uniqueName(requested: string): string {
		const name = requested
			.normalize("NFKC")
			.replace(/[\p{C}<>]/gu, "")
			.trim()
			.slice(0, 40);
		if (!name) throw new JoinError("Choose a guest name");
		const count = Number(
			this.#db.prepare("SELECT count(*) AS n FROM guests WHERE name=? OR name LIKE ?").get(name, `${name} (%)`)?.n ??
				0,
		);
		return count ? `${name} (${count + 1})` : name;
	}
}
