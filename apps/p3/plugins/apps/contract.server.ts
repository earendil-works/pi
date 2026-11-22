// The apps plugin's contract for server facets: the `Apps` registry, to which every app's server facet contributes
// its entry. `/v1/server` re-exports it.

import { defineRegistry, type TableItem } from "@earendil-works/p3/v1";
import type { AppInfo } from "./contract.ts";

/** The apps of this Pi by id, each with its plugin (the first by plugin name wins an id; a second is reported). */
export const Apps = defineRegistry<AppInfo, ReadonlyMap<string, TableItem<AppInfo>>>("apps.apps", { version: 1 });
