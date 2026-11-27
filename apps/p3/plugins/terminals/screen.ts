// The boundary between the Terminals view and what draws a terminal: a `TerminalScreen` gets a terminal's
// `TerminalLink` (terminal-link.ts: its output in order, its size, and where what is typed and a new size go) and
// draws it. The view shows `GhosttyScreen` (ghostty-screen.tsx); another renderer replaces it without touching the
// view.

import type { ComponentType } from "react";

/** What a screen is told about its terminal while it follows the link. */
export type ScreenFeed = {
	/**
	 * A new connection starts: what follows is the terminal's kept output from its oldest kept byte, the first `kept`
	 * bytes of it old output a screen draws on an empty screen and answers no query of (a replay), then live output.
	 */
	restart(kept: number): void;
	/** Output, in order. */
	output(bytes: Uint8Array): void;
	/** The terminal's size: at each start and after each change (another viewer resized it). */
	size(columns: number, rows: number): void;
};

/** One terminal as a screen reaches it. */
export type TerminalLink = {
	/** Tells `feed` about the terminal until the returned stop, connected again after a connection is lost. */
	follow(feed: ScreenFeed): () => void;
	/** Says that `bytes` more of the output were drawn: the link's flow control (the server sends a window ahead). */
	drawn(bytes: number): void;
	/** Types `bytes` into the terminal; absent where the person may only watch. */
	readonly type?: (bytes: Uint8Array) => void;
	/** Gives the terminal a new size; absent where the person may only watch. */
	readonly resize?: (columns: number, rows: number) => void;
};

/** What a screen gets: its terminal's link, and its label for assistive technology. */
export type TerminalScreenProps = { readonly link: TerminalLink; readonly label: string };

/** A component drawing one terminal. */
export type TerminalScreen = ComponentType<TerminalScreenProps>;
