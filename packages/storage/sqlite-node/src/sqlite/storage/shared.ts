import type { SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { SessionError } from "@earendil-works/pi-agent-core";
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function invalidSession(message: string, cause?: Error): SessionError {
	return new SessionError("invalid_session", `Invalid SQLite session: ${message}`, cause);
}

export function invalidEntry(message: string, cause?: Error): SessionError {
	return new SessionError("invalid_entry", `Invalid SQLite session entry: ${message}`, cause);
}

export function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
	return entry.type === "leaf" ? entry.targetId : entry.id;
}
