import { SessionError } from "@earendil-works/pi-agent-core";
import type { SqliteDatabase } from "../types.ts";

export function createSequence(db: SqliteDatabase, sessionId: string, nextSeq = 1) {
	db.prepare("INSERT INTO session_sequences (session_id, next_seq) VALUES (?, ?)").run(sessionId, nextSeq);
}

export function getNextSequence(db: SqliteDatabase, sessionId: string) {
	const sequenceRow = db
		.prepare("SELECT next_seq FROM session_sequences WHERE session_id = ?")
		.get<{ next_seq: number }>(sessionId);
	if (!sequenceRow) {
		throw new SessionError("storage", `Missing sequence row for session ${sessionId}`);
	}
	return sequenceRow.next_seq;
}

export function setNextSequence(db: SqliteDatabase, sessionId: string, nextSeq: number) {
	db.prepare("UPDATE session_sequences SET next_seq = ? WHERE session_id = ?").run(nextSeq, sessionId);
}

export function advanceSequence(db: SqliteDatabase, sessionId: string, seq: number) {
	setNextSequence(db, sessionId, seq + 1);
}

export function deleteSequence(db: SqliteDatabase, sessionId: string) {
	db.prepare("DELETE FROM session_sequences WHERE session_id = ?").run(sessionId);
}
