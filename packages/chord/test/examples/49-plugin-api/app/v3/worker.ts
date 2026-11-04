// Acme's API v3 for worker facets only (`@acme/app/v3/worker`): a registry of the workers' indexers (example 52).

import { defineRegistry } from "../../../../../src/index.ts";

/** Word indexers a worker runs over a project's notes: each contributes its name. */
export const Indexers = defineRegistry<{ readonly name: string }, readonly string[]>("acme.indexers", { version: 1 });
