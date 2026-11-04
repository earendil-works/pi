// The todo app's API v1 for terminal facets (`@todo/app/v1/tui`): the `Screens` registry the terminal draws, one part
// per contributing plugin.

import { defineRegistry } from "../../../../../../src/index.ts";
import type { TerminalTheme, TuiScope } from "../../../../../../src/tui/index.ts";

/**
 * A part of the terminal's screen: its name (a key, never shown), and `open`, which holds what the part shows in
 * `scope` (released when the terminal closes it) and returns a reader of its lines, its title first, coloured by role
 * with `theme`.
 */
export type Screen = {
	readonly name: string;
	readonly open: (scope: TuiScope, theme: TerminalTheme) => () => readonly string[];
};

/** The terminal's parts, in plugin-name order. */
export const Screens = defineRegistry<Screen, readonly Screen[]>("todo.screens", { version: 1 });
