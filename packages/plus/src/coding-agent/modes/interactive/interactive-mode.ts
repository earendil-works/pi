/**
 * Wrapper for packages/coding-agent/src/modes/interactive/interactive-mode.ts.
 *
 * Pass-through except: the built-in /login flow is disabled. Both entry
 * points — handleInput's typed-"/login" interception and the slash-command
 * path — delegate to the (TS-private, prototype-visible) handleLoginCommand
 * method, so replacing it on the prototype kills every route into the login
 * UI without touching upstream. Provider login lives in
 * `pipi profile add <name> -p <provider>` (packages/plus/src/auth/login.ts),
 * which logs a profile into a provider and writes the credential to that
 * profile's agent dir; /logout stays available (it only removes credentials,
 * which is still meaningful for env- and login-stored entries).
 */
export * from "../../../../../coding-agent/src/modes/interactive/interactive-mode.ts";

import { InteractiveMode } from "../../../../../coding-agent/src/modes/interactive/interactive-mode.ts";

// Structural view of the private members the patch calls; the original method
// is TS-private, so there is no public type to reference here.
interface StatusDisplaying {
	showStatus(message: string): void;
}

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	handleLoginCommand(this: StatusDisplaying, providerRef?: string): Promise<void>;
};

interactiveModePrototype.handleLoginCommand = async function handleLoginCommand(
	this: StatusDisplaying,
	_providerRef?: string,
): Promise<void> {
	this.showStatus(
		"Provider login moved: use 'pipi profile add <name> -p <provider>' (or 'pipi profile update <name> -t <key>').",
	);
};
