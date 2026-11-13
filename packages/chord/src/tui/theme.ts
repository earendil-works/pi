// The terminal's theme lookup (slice 11 §4b, decision "Looks and themes"): colours by role from the active theme, as
// the terminal shows them (true colour, else the nearest of 256; a theme's `tui` overrides first). A plugin asks for a
// role (`theme.fg("accent", "Notes")`), never writes raw colours; a new theme applies at the next redraw.

import { type ColorDepth, type Theme, terminalColor } from "../surfaces/index.ts";

/** Colours by role for the terminal. */
export class TerminalTheme {
	readonly #depth: ColorDepth;
	#theme: Theme;
	readonly #listeners = new Set<() => void>();

	constructor(theme: Theme, depth: ColorDepth) {
		this.#theme = theme;
		this.#depth = depth;
	}

	/** The active theme. */
	get theme(): Theme {
		return this.#theme;
	}

	/** `text` in `role`'s colour (the default colour after it). */
	fg(role: string, text: string): string {
		return `\x1b[${terminalColor(this.#theme, role, this.#depth, "fg")}m${text}\x1b[39m`;
	}

	/** `text` on `role`'s colour as its background. */
	bg(role: string, text: string): string {
		return `\x1b[${terminalColor(this.#theme, role, this.#depth, "bg")}m${text}\x1b[49m`;
	}

	/** Calls `listener` when the active theme changes (to redraw) until the returned removal. */
	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The active theme is now `theme`. */
	set(theme: Theme): void {
		this.#theme = theme;
		for (const listener of this.#listeners) listener();
	}
}
