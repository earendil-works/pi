import type { ProtocolError, ProtocolErrorCode } from "@earendil-works/pi-protocol";

export class ServerError extends Error {
	readonly code: ProtocolErrorCode;

	constructor(error: ProtocolError) {
		super(error.message);
		this.name = "ServerError";
		this.code = error.code;
	}
}

export class DisconnectedError extends Error {
	constructor(message = "Client is disconnected", cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "DisconnectedError";
	}
}

export class ClientDisposedError extends Error {
	constructor() {
		super("Client is disposed");
		this.name = "ClientDisposedError";
	}
}

export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function toDisconnectedError(error: unknown): DisconnectedError {
	const cause = toError(error);
	return cause instanceof DisconnectedError ? cause : new DisconnectedError(cause.message, cause);
}
