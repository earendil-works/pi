import type { SqliteDatabase } from "../types.ts";

export interface WriterLease {
	ownerId: string;
	fence: number;
	expiresAtMs: number;
}

interface WriterLeaseRow {
	owner_id: string;
	fence: number;
	expires_at_ms: number;
}

export function acquireWriterLease(
	db: SqliteDatabase,
	sessionId: string,
	ownerId: string,
	now: number,
	expiresAtMs: number,
) {
	const row = db
		.prepare(
			`INSERT INTO writer_leases (session_id, owner_id, fence, expires_at_ms)
			VALUES (?, ?, 1, ?)
			ON CONFLICT(session_id) DO UPDATE SET
				owner_id = excluded.owner_id,
				fence = writer_leases.fence + 1,
				expires_at_ms = excluded.expires_at_ms
			WHERE writer_leases.expires_at_ms <= ?
			RETURNING owner_id, fence, expires_at_ms`,
		)
		.get<WriterLeaseRow>(sessionId, ownerId, expiresAtMs, now);
	return row === undefined ? undefined : { ownerId: row.owner_id, fence: row.fence, expiresAtMs: row.expires_at_ms };
}

export function renewWriterLease(
	db: SqliteDatabase,
	sessionId: string,
	lease: WriterLease,
	now: number,
	expiresAtMs: number,
) {
	const result = db
		.prepare(
			`UPDATE writer_leases
			SET expires_at_ms = ?
			WHERE session_id = ? AND owner_id = ? AND fence = ? AND expires_at_ms > ?`,
		)
		.run(expiresAtMs, sessionId, lease.ownerId, lease.fence, now);
	if (result.changes === 1) lease.expiresAtMs = expiresAtMs;
	return result.changes === 1;
}

export function releaseWriterLease(db: SqliteDatabase, sessionId: string, lease: WriterLease) {
	db.prepare("DELETE FROM writer_leases WHERE session_id = ? AND owner_id = ? AND fence = ?").run(
		sessionId,
		lease.ownerId,
		lease.fence,
	);
}

export function deleteWriterLease(db: SqliteDatabase, sessionId: string) {
	db.prepare("DELETE FROM writer_leases WHERE session_id = ?").run(sessionId);
}
