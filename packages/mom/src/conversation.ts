import type { SlackEvent } from "./slack.js";

/** Synthetic Slack user id for filesystem-driven events — shared session per channel. */
export const MOM_EVENTS_SESSION_ROOT = "__mom_events__";

export function getSessionThreadRoot(event: SlackEvent): string {
	if (event.user === "EVENT") {
		return MOM_EVENTS_SESSION_ROOT;
	}
	return event.threadTs ?? event.ts;
}

export function getConversationKey(channelId: string, sessionThreadRoot: string): string {
	return `${channelId}:${sessionThreadRoot}`;
}

/**
 * Safe directory name under .mom-sessions/ (Slack ts uses digits and dot).
 */
export function sanitizeSessionDirSegment(sessionThreadRoot: string): string {
	return sessionThreadRoot.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function runnerCacheKey(channelId: string, sessionThreadRoot: string): string {
	return `${channelId}\0${sessionThreadRoot}`;
}
