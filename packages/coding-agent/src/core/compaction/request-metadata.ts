import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple, uuidv7 } from "@earendil-works/pi-ai/compat";

export const REQUEST_IDENTITY_METADATA_KEY = "pi.requestIdentity";

export interface InternalRequestIdentity {
	sessionId: string;
	threadId: string;
	turnId: string;
	requestKind: "turn" | "compaction";
	startedAt: number;
	windowId?: string;
	windowNumber?: number;
	contextWindowId?: string;
}

export function getRequestIdentityMetadata(
	metadata: Record<string, unknown> | undefined,
): InternalRequestIdentity | undefined {
	const value = metadata?.[REQUEST_IDENTITY_METADATA_KEY];
	if (!value || typeof value !== "object") return undefined;
	return value as InternalRequestIdentity;
}

export function setRequestIdentityMetadata(
	metadata: Record<string, unknown> | undefined,
	identity: InternalRequestIdentity,
): Record<string, unknown> {
	return { ...metadata, [REQUEST_IDENTITY_METADATA_KEY]: identity };
}

export function withCompactionRequestMetadata(streamFn: StreamFn = streamSimple): StreamFn {
	const sessionId = uuidv7();
	const identity = {
		sessionId,
		threadId: sessionId,
		turnId: uuidv7(),
		requestKind: "compaction",
		startedAt: Date.now(),
	} satisfies InternalRequestIdentity;
	return (model, context, options) =>
		streamFn(model, context, {
			...options,
			metadata: setRequestIdentityMetadata(options?.metadata, identity),
		});
}
