// The todo app's API v1 for web facets (`@todo/app/v1/web`): the `Panels` registry the page shows, and Chord's React
// hooks, `useMessages` among them (a plugin imports them from here: Chord itself is not a package plugins may name).

import type { ComponentType } from "react";
import { defineRegistry } from "../../../../../../src/index.ts";

export { useHold, useMessages, usePageState, useWatch } from "../../../../../../src/react/index.ts";

/** A panel of the page: its name (a key, never shown) and its React component, which shows its own title. */
export type Panel = { readonly name: string; readonly Component: ComponentType };

/** The page's panels, one per contributing plugin, in plugin-name order. */
export const Panels = defineRegistry<Panel, readonly Panel[]>("todo.panels", { version: 1 });
