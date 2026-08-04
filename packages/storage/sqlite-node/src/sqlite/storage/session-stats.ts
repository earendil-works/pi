import { SessionError, type SessionStats } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { SqliteDatabase } from "../types.ts";

export interface SessionStatsRow {
	session_id: string;
	message_count: number;
	cached_tokens: number;
	uncached_tokens: number;
	total_tokens: number;
	cost_total: number;
}

export function createStats(db: SqliteDatabase, sessionId: string): void {
	db.prepare(
		`INSERT INTO session_stats
			(session_id, message_count, cached_tokens, uncached_tokens, total_tokens, cost_total)
			VALUES (?, 0, 0, 0, 0, 0)`,
	).run(sessionId);
}

export function readStats(db: SqliteDatabase, sessionId: string): SessionStats {
	const row = db
		.prepare(
			`SELECT session_id, message_count, cached_tokens, uncached_tokens, total_tokens, cost_total
			FROM session_stats
			WHERE session_id = ?`,
		)
		.get<SessionStatsRow>(sessionId);
	if (!row) throw new SessionError("storage", `Missing stats row for session ${sessionId}`);
	return {
		messageCount: row.message_count,
		cachedTokens: row.cached_tokens,
		uncachedTokens: row.uncached_tokens,
		totalTokens: row.total_tokens,
		costTotal: row.cost_total,
	};
}

export function incrementMessageCount(db: SqliteDatabase, sessionId: string): void {
	const result = db
		.prepare("UPDATE session_stats SET message_count = message_count + 1 WHERE session_id = ?")
		.run(sessionId);
	if (result.changes !== 1) throw new SessionError("storage", `Missing stats row for session ${sessionId}`);
}

export function addUsageToStats(db: SqliteDatabase, sessionId: string, usage: Usage): void {
	const result = db
		.prepare(
			`UPDATE session_stats
			SET cached_tokens = cached_tokens + ?,
				uncached_tokens = uncached_tokens + ?,
				total_tokens = total_tokens + ?,
				cost_total = cost_total + ?
			WHERE session_id = ?`,
		)
		.run(usage.cacheRead, usage.input + usage.cacheWrite, usage.totalTokens, usage.cost.total, sessionId);
	if (result.changes !== 1) throw new SessionError("storage", `Missing stats row for session ${sessionId}`);
}

export function deleteStats(db: SqliteDatabase, sessionId: string): void {
	db.prepare("DELETE FROM session_stats WHERE session_id = ?").run(sessionId);
}
