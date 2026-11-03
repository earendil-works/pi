// The terminal API of the TUI tests (`@test/app/v1/tui`): a registry of lines terminal plugins contribute, which the
// fixture's entry draws.

import { defineRegistry } from "../../../../src/index.ts";

/** Lines plugins contribute, drawn in plugin-name order. */
export const Lines = defineRegistry<string, readonly string[]>("test.lines", { version: 1 });
