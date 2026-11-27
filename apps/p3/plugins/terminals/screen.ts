// The boundary between the Terminals view and what draws a terminal: a screen (a component of `TerminalScreenProps`)
// gets a terminal's `TerminalLink` (terminal-link.ts: its output in order, its size, and where what is typed and a new
// size go) and draws it. The view shows `GhosttyScreen` (ghostty-screen.tsx); another renderer takes its place there.

/** What a screen is told about its terminal while it follows the link. */
export type ScreenFeed = {
	/**
	 * A new connection starts: what follows is the terminal's kept output from its oldest kept byte, old output up to
	 * offset `end` of the terminal's output (a replay, drawn on an empty screen, no query of it answered, also when the
	 * connection skips over that offset), then live output.
	 */
	restart(end: number): void;
	/** Output, in order. */
	output(bytes: Uint8Array): void;
	/** The terminal's size: at each start and after each change (another viewer resized it). */
	size(columns: number, rows: number): void;
	/**
	 * Whether this screen answers the program's queries in live output, from the output byte `at` of this connection on
	 * (one screen per terminal does; none by default).
	 */
	answer(yes: boolean, at: number): void;
	/**
	 * The connection was lost: nothing typed can be delivered until the next `restart`, which comes only `again` (not
	 * after the terminal ended or the person was refused).
	 */
	lost(again: boolean): void;
	/** Where in the terminal's output the output that follows starts (before the first, and after bytes skipped). */
	from(offset: number): void;
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
	/** Sends the screen's answer to a program's query; absent where the person may only watch. */
	readonly reply?: (text: string) => void;
};

/** What a screen gets: its terminal's link, and its label for assistive technology. */
export type TerminalScreenProps = { readonly link: TerminalLink; readonly label: string };
