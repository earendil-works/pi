import type { RemoteServiceErrorCode } from "@earendil-works/chord";

type ServerOperationErrorCode =
	| RemoteServiceErrorCode
	| "wrong_server"
	| "session_not_found"
	| "session_ambiguous"
	| "session_not_attached"
	| "server_draining";

export const INTERNAL_SERVER_ERROR_MESSAGE = "Internal server error";

/** A host or lifecycle error that can safely cross the protocol boundary. */
export class ServerError extends Error {
	readonly code: ServerOperationErrorCode;

	constructor(code: ServerOperationErrorCode, message: string) {
		super(message);
		this.name = "ServerError";
		this.code = code;
	}
}

export class WrongServerError extends ServerError {
	constructor() {
		super("wrong_server", "Request was addressed to another server");
		this.name = "WrongServerError";
	}
}

export class SessionNotFoundError extends ServerError {
	constructor(message = "Session was not found") {
		super("session_not_found", message);
		this.name = "SessionNotFoundError";
	}
}

export class SessionAmbiguousError extends ServerError {
	constructor() {
		super("session_ambiguous", "Session ID matches more than one session");
		this.name = "SessionAmbiguousError";
	}
}

export class SessionNotAttachedError extends ServerError {
	constructor() {
		super("session_not_attached", "Session is not attached to this client");
		this.name = "SessionNotAttachedError";
	}
}

export class ServerDrainingError extends ServerError {
	constructor() {
		super("server_draining", "Server is draining");
		this.name = "ServerDrainingError";
	}
}
