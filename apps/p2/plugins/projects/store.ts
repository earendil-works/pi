// The projects' tables in the server's store: one row per project (its order a position with gaps, so a move writes one
// row), one row per session that belongs to a project (a move of a session writes one row), and one row per project
// with a coordinator. Lists of hundreds of projects
// and thousands of sessions stay cheap: no write rewrites a whole collection.
import { arr, str } from "@earendil-works/pi-schema";
import {
	columnInt,
	columnOpt,
	columnStr,
	defineTable,
	jsonColumn,
	query,
	type RowOf,
	type Table,
	type TableOf,
} from "@p2/app/v1";
import { ProjectPlaceSchema } from "./contract.ts";

/**
 * A project: its name (the key: sessions name it), its places (the default first), its position in the owner's order,
 * and while archived, when and the sessions archived with it (a restore brings back these only).
 */
export const ProjectRows = defineTable("projects", {
	version: 1,
	columns: {
		name: columnStr(),
		places: jsonColumn(arr(ProjectPlaceSchema), { version: 1 }),
		position: columnInt(),
		archivedAt: columnOpt(columnInt()),
		archivedSessions: jsonColumn(arr(str()), { version: 1 }),
	},
	key: ["name"],
});

/** The project a session belongs to, by its name; a session in none has no row. */
export const MemberRows = defineTable("project_members", {
	version: 1,
	columns: { session: columnStr(), project: columnStr() },
	key: ["session"],
	indexes: { by_project: ["project"] },
});

/** A project's coordinator: its session, chosen by the first open. A rename moves the row. */
export const CoordinatorRows = defineTable("project_coordinators", {
	version: 1,
	columns: { project: columnStr(), session: columnStr() },
	key: ["project"],
	indexes: { by_session: ["session"] },
});

/** Every project in the owner's order. */
export const BY_POSITION = query(ProjectRows).orderBy((row) => row.position, "asc");

type RowsOf<T> = T extends Table<infer C, readonly string[]> ? RowOf<C> : never;

/** A project's row as stored. */
export type ProjectRow = RowsOf<TableOf<typeof ProjectRows>>;
