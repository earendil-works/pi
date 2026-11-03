// The board app's API v1 for web facets (`@board/app/v1/web`): the `Panels` registry the page shows, one panel per
// contributing plugin.

import { defineRegistry } from "../../../../../src/index.ts";

/** A panel on the board page: its title and its text. */
export type Panel = { readonly title: string; readonly text: string };

/** The page's panels, in plugin-name order. */
export const Panels = defineRegistry<Panel, readonly Panel[]>("board.panels", { version: 1 });
