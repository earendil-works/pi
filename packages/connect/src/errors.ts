// The errors pi-connect rejects with, each with a code an app can act on.

/**
 * `unknown_provider`: the app did not configure the provider. `unavailable`: the method does not work
 * in this browser (the message says why). `popup_blocked`: the browser refused to open the sign-in
 * window, usually because `signIn` did not run in a click handler. `popup_closed`: the window closed
 * before the sign-in finished. `cancelled`: the user cancelled. `sign_in_failed`: the provider's
 * sign-in failed (the message says how).
 */
export type ConnectErrorCode =
	| "unknown_provider"
	| "unavailable"
	| "popup_blocked"
	| "popup_closed"
	| "cancelled"
	| "sign_in_failed";

/** A pi-connect failure. */
export class ConnectError extends Error {
	readonly code: ConnectErrorCode;

	constructor(code: ConnectErrorCode, message: string) {
		super(message);
		this.name = "ConnectError";
		this.code = code;
	}
}
