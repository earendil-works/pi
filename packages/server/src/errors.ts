import type { JsonValue, ProtocolErrorCode } from "@earendil-works/pi-protocol";

export type PiServerOperationErrorCode = Extract<
	ProtocolErrorCode,
	"busy" | "session_locked" | "not_found" | "invalid_request"
>;

/** A backend/runtime error that can safely cross the protocol boundary. */
export class PiServerError extends Error {
	readonly code: PiServerOperationErrorCode;
	readonly details: JsonValue | undefined;

	constructor(code: PiServerOperationErrorCode, message: string, details?: JsonValue) {
		super(message);
		this.name = "PiServerError";
		this.code = code;
		this.details = details;
	}
}

export class SessionBusyError extends PiServerError {
	constructor(message = "Session is busy", details?: JsonValue) {
		super("busy", message, details);
		this.name = "SessionBusyError";
	}
}

export class SessionLockedError extends PiServerError {
	constructor(message = "Session is locked", details?: JsonValue) {
		super("session_locked", message, details);
		this.name = "SessionLockedError";
	}
}

export class SessionNotFoundError extends PiServerError {
	constructor(message = "Session was not found", details?: JsonValue) {
		super("not_found", message, details);
		this.name = "SessionNotFoundError";
	}
}
