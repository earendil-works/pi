// The store's write vocabulary (`StoreWrite`, slice 6a §7, §8; decision "Writes carry their versions"): one change of
// the store each, as the outbox and archives record it.

import type { DocumentWrite } from "./engine.ts";
import type { TableWrite } from "./table-writes.ts";

/** One change of the store, tagged by `kind`. */
export type StoreWrite = DocumentWrite | TableWrite;
