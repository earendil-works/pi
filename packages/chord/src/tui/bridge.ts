// The terminal's bridge (slice 11 §4, decision "Slice 11, P8"): the only way between the sandbox, where the app's
// terminal code and the plugins run, and the trusted launcher outside it. The launcher sends input, resizes and the
// relayed bytes of the Chord link; the sandbox sends frames for the terminal, opens and feeds link sockets through the
// launcher, asks for plugin scripts and the server's base hash, and asks for actions on the machine (copy, open a URL,
// attach a file the user names), which the launcher confirms with the user. Messages are plain data, framed over the
// sandbox's pipes (`src/node/tui/pipe.ts`); requests carry an id their reply has.

/** What the launcher tells the sandbox at its start. */
export type BridgeStart = {
	/** The base bundle's hash (the sandbox runs it). */
	readonly base: string;
	/** The text of the combined plugin scripts at start. */
	readonly combined: string;
	readonly columns: number;
	readonly rows: number;
	/** How many colours the terminal shows. */
	readonly colors: "truecolor" | "256";
	/** The terminal's background: which of the user's two themes applies. */
	readonly mode: "dark" | "light";
	/** The user's languages, from the system's locale (`de-DE`), most preferred first. */
	readonly locales: readonly string[];
};

/** A request of the sandbox the launcher answers. */
export type BridgeRequest =
	| { readonly kind: "fetch"; readonly path: string }
	| { readonly kind: "base" }
	| { readonly kind: "copy"; readonly text: string }
	| { readonly kind: "open"; readonly url: string }
	/** A file of the machine the user names (`path`): its name and bytes once confirmed, else `null`. */
	| { readonly kind: "attach"; readonly path: string };

/** What the sandbox sends. */
export type SandboxMessage =
	| { readonly kind: "write"; readonly data: string }
	| { readonly kind: "socket_open"; readonly socket: number }
	| { readonly kind: "socket_send"; readonly socket: number; readonly bytes: Uint8Array }
	| { readonly kind: "socket_close"; readonly socket: number }
	| { readonly kind: "request"; readonly id: number; readonly request: BridgeRequest }
	/** The sandbox's code is outdated (a new base bundle): the launcher starts a new one. */
	| { readonly kind: "outdated" }
	/** The base bundle failed to start (its message; the launcher shows none of the sandbox's own output). */
	| { readonly kind: "failed"; readonly message: string }
	| { readonly kind: "exit"; readonly code: number };

/** What the launcher sends. */
export type LauncherMessage =
	| { readonly kind: "input"; readonly data: string }
	| { readonly kind: "resize"; readonly columns: number; readonly rows: number }
	| { readonly kind: "socket_opened"; readonly socket: number }
	| { readonly kind: "socket_message"; readonly socket: number; readonly bytes: Uint8Array }
	| { readonly kind: "socket_closed"; readonly socket: number }
	| { readonly kind: "reply"; readonly id: number; readonly value: unknown }
	/** An attach request's answer: the file the user confirmed. */
	| { readonly kind: "attached"; readonly id: number; readonly name: string; readonly bytes: Uint8Array }
	| { readonly kind: "refused"; readonly id: number; readonly message: string };

/** The bridge as the sandbox's code gets it from the bootstrap (once: it is taken off `globalThis`). */
export type Bridge = {
	readonly start: BridgeStart;
	send(message: SandboxMessage): void;
	onMessage(listener: (message: LauncherMessage) => void): void;
	/**
	 * Runs `source` (registered plugin scripts) in the sandbox's context, as the bootstrap ran the base bundle: with no
	 * dynamic import callback (`import()` throws).
	 */
	evaluate(source: string, filename: string): void;
};

/** The global the sandbox's bootstrap leaves the bridge on, for the base bundle's runtime to take. */
export const BRIDGE = "chordBridge";
