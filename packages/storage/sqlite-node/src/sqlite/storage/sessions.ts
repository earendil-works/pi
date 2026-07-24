import { SessionError } from "@earendil-works/pi-agent-core";
import type { SqliteSessionMetadata } from "../types.ts";

export interface SessionRow {
	id: string;
	created_at: string;
	metadata: string | null;
	cwd: string;
	parent_session_id: string | null;
	active_leaf_id: string | null;
}

function parseMetadata(metadata: string | null, sessionId: string): Record<string, unknown> | undefined {
	if (metadata === null) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(metadata);
	} catch (error) {
		throw new SessionError(
			"invalid_session",
			`Invalid SQLite session ${sessionId}: metadata is not valid JSON`,
			error instanceof Error ? error : undefined,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new SessionError("invalid_session", `Invalid SQLite session ${sessionId}: metadata must be an object`);
	}
	return parsed as Record<string, unknown>;
}

export function rowToMetadata(row: SessionRow, path: string): SqliteSessionMetadata {
	return {
		id: row.id,
		createdAt: row.created_at,
		cwd: row.cwd,
		path,
		parentSessionId: row.parent_session_id ?? undefined,
		metadata: parseMetadata(row.metadata, row.id),
	};
}
