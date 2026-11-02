// Acme's API v3 for web facets only (`@acme/app/v3/web`): the panels a page shows.

import { defineRegistry } from "../../../../../../src/next/index.ts";

/** A panel's title, one per contributing plugin. */
export const Panels = defineRegistry<{ readonly title: string }, readonly string[]>("acme.panels", { version: 1 });
