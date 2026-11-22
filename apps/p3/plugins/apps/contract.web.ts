// The apps plugin's contract for web facets: `AppPages`, to which every app's web facet contributes its page, the
// whole page below the top bar. `/v1/web` re-exports it.

import { defineRegistry, type TableItem } from "@earendil-works/p3/v1";
import type { ComponentType } from "react";

/** An app's page: its app's id and the component rendered below the top bar (the rest of the route is `useRoute`'s). */
export type AppPage = { readonly app: string; readonly Page: ComponentType };

/** The apps' pages by app id (the first by plugin name wins an id; a second is reported). */
export const AppPages = defineRegistry<AppPage, ReadonlyMap<string, TableItem<AppPage>>>("apps.pages", { version: 1 });
