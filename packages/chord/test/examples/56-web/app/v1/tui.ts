// The board app's API v1 for terminal facets (`@board/app/v1/tui`): the `Lines` registry the terminal draws.

import { defineRegistry } from "../../../../../src/index.ts";

/** Lines of the terminal board, in plugin-name order. */
export const Lines = defineRegistry<string, readonly string[]>("board.lines", { version: 1 });
