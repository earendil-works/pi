// Each session's subagents as rows of the server's Chord store (`ChildStore`'s table), one row per session keyed by its
// address (decision "Documents and table rows can belong to a host"): a session's export, import and delete carry them.
import { arr } from "@earendil-works/pi-schema";
import { defineTable, hostColumn, jsonColumn, type RowOf, Session, type Table, type TableOf } from "@p2/app/v1";
import { ChildSchema } from "./contract.ts";

export const ChildRows = defineTable("children", {
	version: 1,
	columns: { session: hostColumn(Session), children: jsonColumn(arr(ChildSchema), { version: 1 }) },
	key: ["session"],
});
export type ChildTable = TableOf<typeof ChildRows>;
export type ChildRow = ChildTable extends Table<infer C, readonly string[]> ? RowOf<C> : never;
