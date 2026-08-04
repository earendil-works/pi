import type { SqliteDatabase } from "../types.ts";

export interface SessionLease {
	ownerId: string;
	fence: number;
	expiresAtMs: number;
}

interface SessionLeaseRow {
	owner_id: string;
	fence: number;
	expires_at_ms: number;
}

export async function acquireSessionLease(
	db: SqliteDatabase,
	sessionId: string,
	ownerId: string,
	now: number,
	expiresAtMs: number,
): Promise<SessionLease | undefined> {
	const row = await db
		.prepare(
			`INSERT INTO leases (session_id, owner_id, fence, expires_at_ms)
			VALUES (?, ?, 1, ?)
			ON CONFLICT(session_id) DO UPDATE SET
				owner_id = excluded.owner_id,
				fence = leases.fence + 1,
				expires_at_ms = excluded.expires_at_ms
			WHERE leases.expires_at_ms <= ?
			RETURNING owner_id, fence, expires_at_ms`,
		)
		.get<SessionLeaseRow>(sessionId, ownerId, expiresAtMs, now);
	return row === undefined ? undefined : { ownerId: row.owner_id, fence: row.fence, expiresAtMs: row.expires_at_ms };
}

export async function renewSessionLease(
	db: SqliteDatabase,
	sessionId: string,
	lease: SessionLease,
	now: number,
	expiresAtMs: number,
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE leases
			SET expires_at_ms = ?
			WHERE session_id = ? AND owner_id = ? AND fence = ? AND expires_at_ms > ?`,
		)
		.run(expiresAtMs, sessionId, lease.ownerId, lease.fence, now);
	if (result.changes === 1) lease.expiresAtMs = expiresAtMs;
	return result.changes === 1;
}

export async function releaseSessionLease(db: SqliteDatabase, sessionId: string, lease: SessionLease): Promise<void> {
	await db
		.prepare("DELETE FROM leases WHERE session_id = ? AND owner_id = ? AND fence = ?")
		.run(sessionId, lease.ownerId, lease.fence);
}

export async function deleteSessionLease(db: SqliteDatabase, sessionId: string): Promise<void> {
	await db.prepare("DELETE FROM leases WHERE session_id = ?").run(sessionId);
}
