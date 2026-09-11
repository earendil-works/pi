import type { SessionStats, UsageRow } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { sql } from "../sql.ts";
import type { SqliteDatabase } from "../types.ts";
import { readSessionRow } from "./session-row.ts";

function addUsage(left: Usage, right: Usage): Usage {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined
			? {}
			: { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }),
		...(left.reasoning === undefined && right.reasoning === undefined
			? {}
			: { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

export function readSessionStats(db: SqliteDatabase, sessionId: string): SessionStats {
	const row = readSessionRow(db, sessionId);
	return {
		messageCount: row.message_count,
		usage: JSON.parse(row.usage_payload) as Usage,
	};
}

export function incrementMessageCount(db: SqliteDatabase, sessionId: string): void {
	sql`UPDATE sessions SET message_count = message_count + 1 WHERE id = ${sessionId}`.run(db);
}

export function addUsageToSessionStats(db: SqliteDatabase, sessionId: string, usage: UsageRow["usage"]): void {
	const current = readSessionStats(db, sessionId).usage;
	sql`UPDATE sessions SET usage_payload = ${JSON.stringify(addUsage(current, usage))} WHERE id = ${sessionId}`.run(db);
}
