import { assertJsonSerializable, SessionError } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase, SqliteSessionMetadata } from "../types.ts";

export interface SessionRow {
	id: string;
	created_at: string;
	metadata: string | null;
	cwd: string;
	parent_session_id: string | null;
}

export interface NewSessionRow {
	id: string;
	createdAt: string;
	cwd: string;
	parentSessionId?: string;
	metadata?: Record<string, unknown>;
}

function parseMetadata(metadata: string | null, sessionId: string): Record<string, unknown> | undefined {
	if (metadata === null) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(metadata);
	} catch (error) {
		throw new SessionError(
			"storage",
			`Invalid SQLite session ${sessionId}: metadata is not valid JSON`,
			error instanceof Error ? error : undefined,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new SessionError("storage", `Invalid SQLite session ${sessionId}: metadata must be an object`);
	}
	return parsed as Record<string, unknown>;
}

export function sessionExists(db: SqliteDatabase, sessionId: string) {
	return !!db.prepare("SELECT 1 AS found FROM sessions WHERE id = ?").get<{ found: number }>(sessionId);
}

function serializeMetadata(metadata: Record<string, unknown> | undefined): string | null {
	if (metadata === undefined) return null;
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
		throw new SessionError("invalid_payload", "SQLite session metadata must be an object");
	}
	assertJsonSerializable(metadata);
	return JSON.stringify(metadata);
}

export function insertSessionRow(db: SqliteDatabase, session: NewSessionRow) {
	db.prepare("INSERT INTO sessions (id, created_at, metadata, cwd, parent_session_id) VALUES (?, ?, ?, ?, ?)").run(
		session.id,
		session.createdAt,
		serializeMetadata(session.metadata),
		session.cwd,
		session.parentSessionId ?? null,
	);
}

export function readSessionRow(db: SqliteDatabase, sessionId: string) {
	return db
		.prepare("SELECT id, created_at, metadata, cwd, parent_session_id FROM sessions WHERE id = ?")
		.get<SessionRow>(sessionId);
}

export function readSessionRows(db: SqliteDatabase, options: { cwd?: string } = {}) {
	return options.cwd
		? db
				.prepare(
					"SELECT id, created_at, metadata, cwd, parent_session_id FROM sessions WHERE cwd = ? ORDER BY created_at DESC",
				)
				.all<SessionRow>(options.cwd)
		: db
				.prepare("SELECT id, created_at, metadata, cwd, parent_session_id FROM sessions ORDER BY created_at DESC")
				.all<SessionRow>();
}

export function deleteSessionRow(db: SqliteDatabase, sessionId: string) {
	db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function rowToMetadata(row: SessionRow, path: string): SqliteSessionMetadata {
	return {
		id: row.id,
		createdAt: Date.parse(row.created_at),
		cwd: row.cwd,
		path,
		parentSessionId: row.parent_session_id ?? undefined,
		metadata: parseMetadata(row.metadata, row.id),
	};
}
