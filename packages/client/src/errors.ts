import type { JsonValue, ProtocolError, ProtocolErrorCode } from "@earendil-works/pi-protocol";

export class PiServerError extends Error {
	readonly code: ProtocolErrorCode;
	readonly details: JsonValue | undefined;

	constructor(error: ProtocolError) {
		super(error.message);
		this.name = "PiServerError";
		this.code = error.code;
		this.details = error.details;
	}
}

export class PiDisconnectedError extends Error {
	constructor(message = "Pi client is disconnected") {
		super(message);
		this.name = "PiDisconnectedError";
	}
}

export class PiClientDisposedError extends Error {
	constructor() {
		super("Pi client is disposed");
		this.name = "PiClientDisposedError";
	}
}

export class PiSessionOwnershipError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string, message: string) {
		super(message);
		this.name = "PiSessionOwnershipError";
		this.sessionId = sessionId;
	}
}

export class PiSessionDetachedError extends Error {
	readonly sessionId: string;

	constructor(sessionId: string) {
		super(`Session ${sessionId} is not attached`);
		this.name = "PiSessionDetachedError";
		this.sessionId = sessionId;
	}
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function toDisconnectedError(error: unknown): PiDisconnectedError {
	const cause = toError(error);
	return cause instanceof PiDisconnectedError ? cause : new PiDisconnectedError(cause.message);
}
