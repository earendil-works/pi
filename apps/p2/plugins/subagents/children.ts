// Each session's subagents as rows of the server's Chord store (`ChildStore`'s table), one row per session keyed by its
// address (decision "Documents and table rows can belong to a host"): a session's export, import and delete carry them.
import { arr } from "@earendil-works/pi-schema";
import {
	defineTable,
	evolveTable,
	hostColumn,
	jsonColumn,
	type RowOf,
	Session,
	type Table,
	type TableOf,
} from "@p2/app/v1";
import { type Child, ChildSchema, ChildSchemaV2 } from "./contract.ts";

const ChildRowsV1 = defineTable("children", {
	version: 1,
	columns: { session: hostColumn(Session), children: jsonColumn(arr(ChildSchemaV2), { version: 1 }) },
	key: ["session"],
});

/** 2: a child's time and failure; version 1's children have none of them, so they read as they are. */
export const ChildRows = evolveTable(ChildRowsV1, (t) =>
	t.json(
		"children",
		// A version 1 cell is a valid version 2 one: the fields it lacks are all optional (the column checks the result).
		jsonColumn(arr(ChildSchema), { version: 2, migrate: (old) => old as Child[] }),
	),
);
export type ChildTable = TableOf<typeof ChildRows>;
export type ChildRow = ChildTable extends Table<infer C, readonly string[]> ? RowOf<C> : never;
