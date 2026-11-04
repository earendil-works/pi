// The message index (SQLite FTS5): user/assistant text and catch-up cursors per conversation.
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IndexedMessage } from "./contract.ts";

/** Bump when the schema or what is indexed changes: the index is dropped and rebuilt by catch-up. */
const SCHEMA_VERSION = 2;

export type MessageHit = {
	session: string;
	conversationId: number;
	entryId: number;
	role: "user" | "assistant";
	text: string;
};

export class SearchDb {
	readonly #db: DatabaseSync;

	constructor(directory: string) {
		const path = join(directory, "search.sqlite");
		this.#db = new DatabaseSync(path);
		chmodSync(path, 0o600);
		this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
		const version = Number(this.#db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
		// Derived data: an unknown version is dropped, and every session's cursor starts again at 0.
		if (version !== SCHEMA_VERSION)
			this.#db.exec(`
				DROP TRIGGER IF EXISTS messages_insert; DROP TRIGGER IF EXISTS messages_delete;
				DROP TABLE IF EXISTS message_search; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS cursors;
			`);
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				rowid INTEGER PRIMARY KEY, session TEXT NOT NULL, conversationId INTEGER NOT NULL,
				entryId INTEGER NOT NULL, role TEXT NOT NULL, timestamp INTEGER NOT NULL, text TEXT NOT NULL,
				UNIQUE(session, conversationId, entryId)
			) STRICT;
			CREATE TABLE IF NOT EXISTS cursors (
				session TEXT NOT NULL, conversationId INTEGER NOT NULL, through INTEGER NOT NULL,
				PRIMARY KEY(session, conversationId)
			) STRICT;
			CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(text, content='messages', content_rowid='rowid');
			CREATE TRIGGER IF NOT EXISTS messages_insert AFTER INSERT ON messages BEGIN
				INSERT INTO message_search(rowid,text) VALUES (new.rowid,new.text);
			END;
			CREATE TRIGGER IF NOT EXISTS messages_delete AFTER DELETE ON messages BEGIN
				INSERT INTO message_search(message_search,rowid,text) VALUES ('delete',old.rowid,old.text);
			END;
			PRAGMA user_version=${SCHEMA_VERSION};
		`);
		// Not derived: what the owner has read survives rebuilds of the index (entry IDs are stable). Answers from before
		// the table existed count as read: unread starts with the next answer, not with every old session.
		const fresh = !this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reads'").get();
		this.#db.exec(`CREATE TABLE IF NOT EXISTS reads (session TEXT PRIMARY KEY, through INTEGER NOT NULL) STRICT;`);
		if (fresh)
			this.#db.exec(
				"INSERT INTO reads(session,through) SELECT session, max(entryId) FROM messages WHERE conversationId=1 AND role='assistant' GROUP BY session",
			);
	}

	#transaction(fn: () => void): void {
		this.#db.exec("BEGIN IMMEDIATE");
		try {
			fn();
			this.#db.exec("COMMIT");
		} catch (error) {
			this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	cursor(session: string, conversation: number): number {
		return Number(
			this.#db.prepare("SELECT through FROM cursors WHERE session=? AND conversationId=?").get(session, conversation)
				?.through ?? 0,
		);
	}

	/** Inserts the messages (an entry already indexed is kept) and advances the cursor, atomically. */
	index(session: string, conversation: number, messages: readonly IndexedMessage[], through: number): void {
		this.#transaction(() => {
			const insert = this.#db.prepare(`INSERT INTO messages (session,conversationId,entryId,role,timestamp,text)
				VALUES (?,?,?,?,?,?) ON CONFLICT(session,conversationId,entryId) DO NOTHING`);
			for (const message of messages)
				insert.run(session, message.conversationId, message.entryId, message.role, message.timestamp, message.text);
			this.#db
				.prepare(`INSERT INTO cursors(session,conversationId,through) VALUES(?,?,?)
					ON CONFLICT(session,conversationId) DO UPDATE SET through=max(through,excluded.through)`)
				.run(session, conversation, through);
		});
	}

	firstUserText(session: string): string | undefined {
		const row = this.#db
			.prepare(
				"SELECT text FROM messages WHERE session=? AND conversationId=1 AND role='user' ORDER BY entryId LIMIT 1",
			)
			.get(session);
		return row ? String(row.text) : undefined;
	}

	/** Each session's latest indexed answer: the highest assistant entry ID of its root conversation. */
	answers(): Record<string, number> {
		const rows = this.#db
			.prepare(
				"SELECT session, max(entryId) AS entryId FROM messages WHERE conversationId=1 AND role='assistant' GROUP BY session",
			)
			.all();
		return Object.fromEntries(rows.map((row) => [String(row.session), Number(row.entryId)]));
	}

	/** Up to which root entry the owner has read each session. */
	reads(): Record<string, number> {
		const rows = this.#db.prepare("SELECT session, through FROM reads").all();
		return Object.fromEntries(rows.map((row) => [String(row.session), Number(row.through)]));
	}

	/** Records that the owner has read `session` through `through` (never moves back). */
	markRead(session: string, through: number): void {
		this.#db
			.prepare(
				"INSERT INTO reads(session,through) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET through=max(through,excluded.through)",
			)
			.run(session, through);
	}

	reset(session: string): void {
		this.#transaction(() => {
			this.#db.prepare("DELETE FROM messages WHERE session=?").run(session);
			this.#db.prepare("DELETE FROM cursors WHERE session=?").run(session);
		});
	}

	/** Best matches of every literal term (never raw FTS syntax) in `sessions`; bounded snippets, at most 41. */
	messages(query: string, sessions: readonly string[]): MessageHit[] {
		const terms = query.trim().split(/\s+/).filter(Boolean);
		if (!terms.length || !sessions.length) return [];
		const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
		return this.#db
			.prepare(`SELECT m.session,m.conversationId,m.entryId,m.role,substr(snippet(message_search,0,'','','…',24),1,300) AS text
				FROM message_search JOIN messages m ON m.rowid=message_search.rowid
				WHERE message_search MATCH ? AND m.session IN (SELECT value FROM json_each(?))
				ORDER BY rank,m.entryId DESC LIMIT 41`)
			.all(match, JSON.stringify(sessions))
			.map((row) => ({
				session: String(row.session),
				conversationId: Number(row.conversationId),
				entryId: Number(row.entryId),
				role: row.role === "user" ? "user" : "assistant",
				text: String(row.text),
			}));
	}

	/**
	 * Matches of the MATCH expression `match` (see `ftsQuery`) in one conversation, below entry `before`: session,
	 * conversation and the bound are applied before ranking and the limit, so other sessions' or later entries never
	 * take a place. At most `limit`, best first; `more` when there were further matches.
	 */
	conversationMessages(
		session: string,
		conversation: number,
		match: string,
		before: number | undefined,
		limit: number,
	): { hits: { entryId: number; role: "user" | "assistant"; snippet: string }[]; more: boolean } {
		const rows = this.#db
			.prepare(`SELECT m.entryId,m.role,substr(snippet(message_search,0,'','','…',24),1,300) AS snippet
				FROM message_search JOIN messages m ON m.rowid=message_search.rowid
				WHERE message_search MATCH ? AND m.session=? AND m.conversationId=? AND m.entryId<?
				ORDER BY rank,m.entryId DESC LIMIT ?`)
			.all(match, session, conversation, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
		return {
			hits: rows.slice(0, limit).map((row) => ({
				entryId: Number(row.entryId),
				role: row.role === "user" ? "user" : "assistant",
				snippet: String(row.snippet),
			})),
			more: rows.length > limit,
		};
	}

	close(): void {
		this.#db.close();
	}
}
