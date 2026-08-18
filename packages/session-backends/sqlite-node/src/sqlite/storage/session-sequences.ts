import { SessionError } from "@earendil-works/pi-agent-core";
import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

export function createSequence(db: SqliteDatabase, sessionId: string, nextSeq = 1) {
	sql`INSERT INTO session_sequences (session_id, next_seq) VALUES (${sessionId}, ${nextSeq})`.run(db);
}

export function getNextSequence(db: SqliteDatabase, sessionId: string) {
	const sequenceRow = sql`SELECT next_seq FROM session_sequences WHERE session_id = ${sessionId}`.get<{
		next_seq: number;
	}>(db);
	if (!sequenceRow) {
		throw new SessionError("storage", `Missing sequence row for session ${sessionId}`);
	}
	return sequenceRow.next_seq;
}

export function setNextSequence(db: SqliteDatabase, sessionId: string, nextSeq: number) {
	sql`UPDATE session_sequences SET next_seq = ${nextSeq} WHERE session_id = ${sessionId}`.run(db);
}

export function advanceSequence(db: SqliteDatabase, sessionId: string, seq: number) {
	setNextSequence(db, sessionId, seq + 1);
}

export function deleteSequence(db: SqliteDatabase, sessionId: string) {
	sql`DELETE FROM session_sequences WHERE session_id = ${sessionId}`.run(db);
}
