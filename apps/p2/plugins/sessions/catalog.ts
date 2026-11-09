// SQLite session catalog (server). Durable owns transcripts; this holds what the sidebar needs without workers.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compile } from "@earendil-works/pi-schema";
import { ModelRefSchema, type SessionInfoState } from "@p2/app/v1";
import type { Session } from "./contract.ts";

const isModelRef = compile(ModelRefSchema).check;

/**
 * 3: `titleEdited` (Pi Mobile's): an explicit title (given at creation or renamed) is never replaced automatically.
 * 4: `main` and `branches`, the current main conversation and the `/tree` branches (`docs/tree.md`).
 */
const SCHEMA_VERSION = 4;

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
	 * Indexed activity: `updatedAt` never moves back. The automatic title is no longer the catalog's: it is a pending edit
	 * the session's worker applies (`automaticTitle`).
	 */
	activity(id: string, timestamp: number): void {
		this.#db.prepare("UPDATE sessions SET updatedAt=max(updatedAt,?) WHERE id=?").run(timestamp, id);
	}

	/** The session's own fields as its worker reported them (`p2.session-info`); the catalog's other fields stay. */
	described(id: string, info: SessionInfoState): void {
		this.#db
			.prepare("UPDATE sessions SET title=?,titleEdited=?,model=?,thinkingLevel=? WHERE id=?")
			.run(info.title, Number(info.titleEdited), JSON.stringify(info.model), info.thinkingLevel, id);
	}

	/** Every row's description by session (`titleEdited` as stored): what the catalog overlays pending edits on. */
	descriptions(): Map<string, SessionInfoState> {
		const rows = this.#db.prepare("SELECT id,title,titleEdited,model,thinkingLevel FROM sessions").all();
		return new Map(rows.map((row) => [String(row.id), this.#description(row)]));
	}

	/** The row's description, the seed of a session that has none yet; `titleEdited` as stored. */
	seed(id: string): SessionInfoState {
		const row = this.#db.prepare("SELECT title,titleEdited,model,thinkingLevel FROM sessions WHERE id=?").get(id);
		if (!row) throw new Error("Session not found");
		return this.#description(row);
	}

	#description(row: Record<string, unknown>): SessionInfoState {
		return {
			title: String(row.title),
			titleEdited: row.titleEdited === 1,
			model: this.#model(row.model),
			thinkingLevel: String(row.thinkingLevel),
		};
	}

	/** The model a row stores as JSON: a `ModelRef`, checked. */
	#model(value: unknown): SessionInfoState["model"] {
		const model: unknown = JSON.parse(String(value));
		if (!isModelRef(model)) throw new Error("Invalid model in the session catalog");
		return { provider: model.provider, modelId: model.modelId };
	}

	close(): void {
		this.#db.close();
	}
}
