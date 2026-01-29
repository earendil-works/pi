import { isLikelyUuid } from "./subscribe-command.js";

export interface SubscriptionSessionSummary {
	id: string;
	modified: Date;
	firstMessage: string;
	messageCount: number;
	title?: string;
}

export interface SubscriptionSessionFilterOptions {
	now: Date;
	maxAgeMs: number;
	currentSessionId: string;
	subscribedSessionIds: Set<string>;
}

export interface SubscriptionSelectItem {
	id: string;
	label: string;
	description: string;
}

export function filterRecentSubscriptionSessions(
	sessions: SubscriptionSessionSummary[],
	options: SubscriptionSessionFilterOptions,
): SubscriptionSessionSummary[] {
	const cutoff = options.now.getTime() - options.maxAgeMs;

	return sessions.filter((session) => {
		if (!isLikelyUuid(session.id)) return false;
		if (options.currentSessionId && session.id === options.currentSessionId) return false;
		if (options.subscribedSessionIds.has(session.id)) return false;
		return session.modified.getTime() >= cutoff;
	});
}

function formatMessageCount(count: number): string {
	return `${count} message${count === 1 ? "" : "s"}`;
}

const MESSAGE_TIMESTAMP_PATTERN = /^<user_message_time>[\s\S]*?<\/user_message_time>\n\n/;

function stripMessageTimestamp(text: string): string {
	return text.replace(MESSAGE_TIMESTAMP_PATTERN, "");
}

function getSessionLabel(session: SubscriptionSessionSummary): string {
	const title = session.title?.trim();
	if (title) return title;

	const trimmed = stripMessageTimestamp(session.firstMessage).trim();
	return trimmed ? trimmed : session.id;
}

export function buildSubscribeSelectItems(sessions: SubscriptionSessionSummary[]): SubscriptionSelectItem[] {
	return sessions.map((session) => ({
		id: session.id,
		label: getSessionLabel(session),
		description: formatMessageCount(session.messageCount),
	}));
}

export function buildUnsubscribeSelectItems(
	subscriptionIds: string[],
	summariesById: Map<string, SubscriptionSessionSummary>,
): SubscriptionSelectItem[] {
	return subscriptionIds.map((subscriptionId) => {
		const summary = summariesById.get(subscriptionId);
		if (!summary) {
			return {
				id: subscriptionId,
				label: subscriptionId,
				description: "Subscribed session",
			};
		}

		return {
			id: summary.id,
			label: getSessionLabel(summary),
			description: formatMessageCount(summary.messageCount),
		};
	});
}
