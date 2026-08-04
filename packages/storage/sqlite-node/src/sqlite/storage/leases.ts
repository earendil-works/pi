import { SessionError } from "@earendil-works/pi-agent-core/experimental";
import type { SqliteDatabase } from "../types.ts";

export interface LeaseRow {
	session_id: string;
	owner: string;
	heartbeat: number;
}

export async function readLease(db: SqliteDatabase, sessionId: string): Promise<LeaseRow | undefined> {
	return db.prepare("SELECT session_id, owner, heartbeat FROM leases WHERE session_id = ?").get<LeaseRow>(sessionId);
}

export async function acquireLease(
	db: SqliteDatabase,
	sessionId: string,
	owner: string,
	heartbeat: number,
	timeoutMs: number,
): Promise<void> {
	await db
		.prepare("INSERT INTO leases (session_id, owner, heartbeat) VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING")
		.run(sessionId, owner, heartbeat);
	const lease = await readLease(db, sessionId);
	if (!lease) throw new SessionError("storage", `Failed to acquire SQLite session lease: ${sessionId}`);
	if (lease.owner === owner) return;
	if (lease.heartbeat <= heartbeat - timeoutMs) {
		const result = await db
			.prepare("UPDATE leases SET owner = ?, heartbeat = ? WHERE session_id = ? AND owner = ? AND heartbeat = ?")
			.run(owner, heartbeat, sessionId, lease.owner, lease.heartbeat);
		if (result.changes === 1) return;
	}
	throw new SessionError("storage", `SQLite session is already leased: ${sessionId}`);
}

export async function assertNoActiveConflictingLease(
	db: SqliteDatabase,
	sessionId: string,
	owner: string,
	heartbeat: number,
	timeoutMs: number,
): Promise<void> {
	const lease = await readLease(db, sessionId);
	if (!lease || lease.owner === owner || lease.heartbeat <= heartbeat - timeoutMs) return;
	throw new SessionError("storage", `SQLite session is already leased: ${sessionId}`);
}

export async function updateLeaseHeartbeats(db: SqliteDatabase, owner: string, heartbeat: number): Promise<void> {
	await db.prepare("UPDATE leases SET heartbeat = ? WHERE owner = ?").run(heartbeat, owner);
}

export async function deleteLease(db: SqliteDatabase, sessionId: string): Promise<void> {
	await db.prepare("DELETE FROM leases WHERE session_id = ?").run(sessionId);
}

export async function deleteLeaseForOwner(db: SqliteDatabase, sessionId: string, owner: string): Promise<void> {
	await db.prepare("DELETE FROM leases WHERE session_id = ? AND owner = ?").run(sessionId, owner);
}

export async function deleteLeasesForOwner(db: SqliteDatabase, owner: string): Promise<void> {
	await db.prepare("DELETE FROM leases WHERE owner = ?").run(owner);
}
