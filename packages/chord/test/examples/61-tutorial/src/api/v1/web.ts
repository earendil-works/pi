// The todo app's API v1 for web facets (`@todo/app/v1/web`): the `Panels` registry the page shows, and Chord's React
// hooks (a plugin imports them from here: Chord itself is not a package plugins may name).

import type { ComponentType } from "react";
import { defineRegistry } from "../../../../../../src/index.ts";

export { useHold, useWatch } from "../../../../../../src/react/index.ts";

/** A panel of the page: its title and its React component. */
export type Panel = { readonly title: string; readonly Component: ComponentType };

/** The page's panels, one per contributing plugin, in plugin-name order. */
export const Panels = defineRegistry<Panel, readonly Panel[]>("todo.panels", { version: 1 });
