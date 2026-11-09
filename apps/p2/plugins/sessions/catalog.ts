// SQLite session catalog (server). Durable owns transcripts; this holds what the sidebar needs without workers.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Session } from "./contract.ts";

/** A session's own description (`p2.session-info`), as the catalog mirrors it. */
export type SessionDescription = {
	title: string;
	titleEdited: boolean;
	cwd: string;
	env: string | null;
	pinned: boolean;
	archivedAt: number | null;
	model: Session["model"];
	thinkingLevel: string;
	createdAt: number;
};

/**
 * 3: `titleEdited` (Pi Mobile's): an explicit title (given at creation or renamed) is never replaced automatically.
 * 4: `main` and `branches`, the current main conversation and the `/tree` branches (`docs/tree.md`).
 */
const SCHEMA_VERSION = 4;
/** An automatic title: the first user message, line breaks as spaces, its first 100 characters (as Pi Mobile). */
const AUTO_TITLE = 100;

export class CatalogDb {
	readonly #db: DatabaseSync;

	constructor(directory: string) {
		this.#db = new DatabaseSync(join(directory, "catalog.sqlite"));
		this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
		const version = Number(this.#db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
		if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== SCHEMA_VERSION) {
			this.#db.close();
			throw new Error(`Unsupported catalog schema: ${version}`);
		}
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY, cwd TEXT NOT NULL, env TEXT, title TEXT NOT NULL,
				createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER,
				pinned INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL, thinkingLevel TEXT NOT NULL,
				titleEdited INTEGER NOT NULL DEFAULT 0, main INTEGER NOT NULL DEFAULT 1,
				branches TEXT NOT NULL DEFAULT '[]'
			) STRICT;
		`);
		if (version === 1) this.#db.exec("ALTER TABLE sessions ADD COLUMN env TEXT;");
		// Before the flag, any title other than the placeholder was explicit or already automatic: keep them all.
		if (version === 1 || version === 2)
			this.#db.exec(
				"ALTER TABLE sessions ADD COLUMN titleEdited INTEGER NOT NULL DEFAULT 0; UPDATE sessions SET titleEdited=1 WHERE title<>'New session';",
			);
		if (version !== 0 && version < 4)
			this.#db.exec(
				"ALTER TABLE sessions ADD COLUMN main INTEGER NOT NULL DEFAULT 1; ALTER TABLE sessions ADD COLUMN branches TEXT NOT NULL DEFAULT '[]';",
			);
		this.#db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
	}

	#decode(row: Record<string, unknown>): Session {
		return {
			id: String(row.id),
			cwd: String(row.cwd),
			env: row.env === null ? null : String(row.env),
			title: String(row.title),
			createdAt: Number(row.createdAt),
			updatedAt: Number(row.updatedAt),
			archivedAt: row.archivedAt === null ? null : Number(row.archivedAt),
			pinned: row.pinned === 1,
			model: JSON.parse(String(row.model)) as Session["model"],
			thinkingLevel: String(row.thinkingLevel),
			main: Number(row.main),
			branches: JSON.parse(String(row.branches)) as Session["branches"],
		};
	}

	all(): Session[] {
		return this.#db
			.prepare("SELECT * FROM sessions ORDER BY updatedAt DESC, id")
			.all()
			.map((row) => this.#decode(row));
	}

	get(id: string): Session {
		const row = this.#db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
		if (!row) throw new Error("Session not found");
		return this.#decode(row);
	}

	create(input: {
		/** A chosen ID (a clone's or fork's); default a new one. */
		id?: string;
		env?: string | null;
		cwd: string;
		title: string;
		/** The title was given (not the placeholder): automatic titles never replace it. */
		titleEdited?: boolean;
		model: Session["model"];
		thinkingLevel: string;
	}): Session {
		const id = input.id ?? randomUUID();
		const now = Date.now();
		this.#db
			.prepare(
				"INSERT INTO sessions (id,cwd,env,title,titleEdited,createdAt,updatedAt,model,thinkingLevel) VALUES (?,?,?,?,?,?,?,?,?)",
			)
			.run(
				id,
				input.cwd,
				input.env ?? null,
				input.title,
				Number(input.titleEdited ?? false),
				now,
				now,
				JSON.stringify(input.model),
				input.thinkingLevel,
			);
		return this.get(id);
	}

	update(
		id: string,
		change: {
			title?: string;
			cwd?: string;
			env?: string | null;
			pinned?: boolean;
			archived?: boolean;
			model?: Session["model"];
			thinkingLevel?: string;
			main?: number;
			branches?: Session["branches"];
		},
	): Session {
		const current = this.get(id);
		const archivedAt =
			change.archived === undefined
				? current.archivedAt
				: change.archived
					? (current.archivedAt ?? Date.now())
					: null;
		// A rename is explicit; a new location counts as activity (Pi Mobile's setLocation).
		const moved = change.cwd !== undefined || change.env !== undefined;
		this.#db
			.prepare(
				"UPDATE sessions SET title=?,titleEdited=CASE WHEN ? THEN 1 ELSE titleEdited END,updatedAt=CASE WHEN ? THEN max(updatedAt,?) ELSE updatedAt END,pinned=?,archivedAt=?,model=?,thinkingLevel=?,cwd=?,env=?,main=?,branches=? WHERE id=?",
			)
			.run(
				change.title ?? current.title,
				Number(change.title !== undefined),
				Number(moved),
				Date.now(),
				Number(change.pinned ?? current.pinned),
				archivedAt,
				JSON.stringify(change.model ?? current.model),
				change.thinkingLevel ?? current.thinkingLevel,
				change.cwd ?? current.cwd,
				change.env === undefined ? (current.env ?? null) : change.env,
				change.main ?? current.main,
				JSON.stringify(change.branches ?? current.branches),
				id,
			);
		return this.get(id);
	}

	/**
	 * The row's description as the session's `p2.session-info` holds it: the seed of a session that has none yet (one
	 * created before it, or a new session's first start).
	 */
	describe(id: string): SessionDescription {
		const row = this.#db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
		if (!row) throw new Error("Session not found");
		const session = this.#decode(row);
		return {
			title: session.title,
			titleEdited: row.titleEdited === 1,
			cwd: session.cwd,
			env: session.env ?? null,
			pinned: session.pinned,
			archivedAt: session.archivedAt,
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			createdAt: session.createdAt,
		};
	}

	/**
	 * The row follows the session's own description (its worker's report): the session is the authority for these
	 * fields. A new location counts as activity, as for `update`. Returns the row after it.
	 */
	mirror(id: string, description: SessionDescription): Session {
		const current = this.get(id);
		const moved = description.cwd !== current.cwd || description.env !== (current.env ?? null);
		this.#db
			.prepare(
				"UPDATE sessions SET title=?,titleEdited=?,cwd=?,env=?,pinned=?,archivedAt=?,model=?,thinkingLevel=?,updatedAt=CASE WHEN ? THEN max(updatedAt,?) ELSE updatedAt END WHERE id=?",
			)
			.run(
				description.title,
				Number(description.titleEdited),
				description.cwd,
				description.env,
				Number(description.pinned),
				description.archivedAt,
				JSON.stringify(description.model),
				description.thinkingLevel,
				Number(moved),
				Date.now(),
				id,
			);
		return this.get(id);
	}

	activity(id: string, timestamp: number, firstUserText?: string): void {
		const title = firstUserText?.replace(/[\r\n]/g, " ").slice(0, AUTO_TITLE);
		this.#db
			.prepare(`UPDATE sessions SET updatedAt=max(updatedAt,?),
			title=CASE WHEN titleEdited=0 AND ?<>'' THEN ? ELSE title END WHERE id=?`)
			.run(timestamp, title ?? "", title ?? "", id);
	}

	close(): void {
		this.#db.close();
	}
}
