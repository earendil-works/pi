import { uuidv7 } from "@earendil-works/pi-ai";

const REQUEST_IDENTITY_METADATA_KEY = "pi.requestIdentity";

interface AgentRequestIdentity {
	sessionId: string;
	threadId: string;
	turnId: string;
	requestKind: "turn";
	startedAt: number;
}

export function createAgentRequestMetadata(sessionId: string): Record<string, unknown> {
	return {
		[REQUEST_IDENTITY_METADATA_KEY]: {
			sessionId,
			threadId: sessionId,
			turnId: uuidv7(),
			requestKind: "turn",
			startedAt: Date.now(),
		} satisfies AgentRequestIdentity,
	};
}

export function getAgentRequestIdentity(
	metadata: Record<string, unknown> | undefined,
): AgentRequestIdentity | undefined {
	const value = metadata?.[REQUEST_IDENTITY_METADATA_KEY];
	if (!value || typeof value !== "object") return undefined;
	return value as AgentRequestIdentity;
}

export function rotateAgentRequestIdentity(metadata: Record<string, unknown> | undefined): void {
	const identity = getAgentRequestIdentity(metadata);
	if (!metadata || !identity) return;
	metadata[REQUEST_IDENTITY_METADATA_KEY] = {
		...identity,
		turnId: uuidv7(),
		startedAt: Date.now(),
	} satisfies AgentRequestIdentity;
}
