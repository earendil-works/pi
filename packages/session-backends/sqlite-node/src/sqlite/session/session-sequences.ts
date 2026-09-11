import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";

export function readNextSeq(db: SqliteDatabase, sessionId: string): number {
	const row = sql`SELECT next_seq FROM sessions WHERE id = ${sessionId}`.get<{ next_seq: number }>(db);
	if (row === undefined) throw new Error(`Unknown SQLite session: ${sessionId}`);
	return row.next_seq;
}

export function advanceNextSeq(db: SqliteDatabase, sessionId: string, nextSeq: number): void {
	const result = sql`UPDATE sessions SET next_seq = ${nextSeq} WHERE id = ${sessionId}`.run(db);
	if (result.changes !== 1)
		throw new Error(`Expected to update one SQLite session ${sessionId}, updated ${result.changes}`);
}
