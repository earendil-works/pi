import { assertJsonSerializable, SessionError } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase, SqliteSessionMetadata } from "../types.ts";

export interface SessionRow {
	id: string;
	created_at: string;
	metadata: string | null;
	cwd: string;
	parent_session_id: string | null;
	has_session_name: number;
	session_name: string | null;
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
		.prepare(
			`SELECT s.id, s.created_at, s.metadata, s.cwd, s.parent_session_id,
				name_fact.seq IS NOT NULL AS has_session_name,
				name_fact.value AS session_name
			FROM sessions AS s
			LEFT JOIN facts AS name_fact
				ON name_fact.session_id = s.id
				AND name_fact.kind = 'name'
				AND name_fact.key IS NULL
				AND name_fact.seq = (
					SELECT MAX(f.seq)
					FROM facts AS f
					WHERE f.session_id = s.id AND f.kind = 'name' AND f.key IS NULL
				)
			WHERE s.id = ?`,
		)
		.get<SessionRow>(sessionId);
}

export function readSessionRows(db: SqliteDatabase, options: { cwd?: string } = {}) {
	const where = options.cwd === undefined ? "" : "WHERE s.cwd = ?";
	return db
		.prepare(
			`SELECT s.id, s.created_at, s.metadata, s.cwd, s.parent_session_id,
				name_fact.seq IS NOT NULL AS has_session_name,
				name_fact.value AS session_name
			FROM sessions AS s
			LEFT JOIN facts AS name_fact
				ON name_fact.session_id = s.id
				AND name_fact.kind = 'name'
				AND name_fact.key IS NULL
				AND name_fact.seq = (
					SELECT MAX(f.seq)
					FROM facts AS f
					WHERE f.session_id = s.id AND f.kind = 'name' AND f.key IS NULL
				)
			${where}
			ORDER BY s.created_at DESC`,
		)
		.all<SessionRow>(...(options.cwd === undefined ? [] : [options.cwd]));
}

export function deleteSessionRow(db: SqliteDatabase, sessionId: string) {
	db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

function parseSessionName(value: string | null, sessionId: string): string {
	if (value === null) {
		throw new SessionError("storage", `Invalid SQLite session ${sessionId}: name must be a string`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new SessionError(
			"storage",
			`Invalid SQLite session ${sessionId}: name is not valid JSON`,
			error instanceof Error ? error : undefined,
		);
	}
	if (typeof parsed !== "string") {
		throw new SessionError("storage", `Invalid SQLite session ${sessionId}: name must be a string`);
	}
	return parsed;
}

export function decodeSessionMetadata(row: SessionRow, path: string): SqliteSessionMetadata {
	const metadata = parseMetadata(row.metadata, row.id);
	const name = row.has_session_name === 0 ? undefined : parseSessionName(row.session_name, row.id);
	return {
		id: row.id,
		createdAt: Date.parse(row.created_at),
		...(name === undefined ? {} : { name }),
		cwd: row.cwd,
		path,
		parentSessionId: row.parent_session_id ?? undefined,
		metadata,
	};
}
