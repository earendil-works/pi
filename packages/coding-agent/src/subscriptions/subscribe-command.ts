export interface SubscribeCommand {
	sessionId: string;
}

export interface UnsubscribeCommand {
	sessionId: string;
}

const SUBSCRIBE_PATTERN = /^\/subscribe(?:\s+([^\s]+))?\s*$/i;
const UNSUBSCRIBE_PATTERN = /^\/unsubscribe(?:\s+([^\s]+))?\s*$/i;

export function isLikelyUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseSubscribeCommand(input: string): SubscribeCommand | null {
	const match = SUBSCRIBE_PATTERN.exec(input.trim());
	if (!match) return null;
	const sessionId = match[1];
	if (!sessionId) return null;
	if (!isLikelyUuid(sessionId)) return null;
	return { sessionId };
}

export function parseUnsubscribeCommand(input: string): UnsubscribeCommand | null {
	const match = UNSUBSCRIBE_PATTERN.exec(input.trim());
	if (!match) return null;
	const sessionId = match[1];
	if (!sessionId) return null;
	if (!isLikelyUuid(sessionId)) return null;
	return { sessionId };
}
