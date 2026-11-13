// The session catalog's rows (server): what the sidebar and the server need about each session while its worker is
// off, as rows of the server's Chord store keyed by the session's address (decision "Documents and table rows can belong
// to a host"), so a session's export, import and delete carry them. Durable owns transcripts.
import { arr } from "@earendil-works/pi-schema";
import {
	columnBool,
	columnInt,
	columnOpt,
	columnStr,
	defineTable,
	evolveTable,
	hostColumn,
	jsonColumn,
	ModelRefSchema,
	query,
	type RowOf,
	Session as SessionHost,
	type Table,
	type TableOf,
	type Tx,
} from "@p2/app/v1";
import { type Branch, BranchSchema, BranchSchemaV5, type Session } from "./contract.ts";

/** One row per session: its place, title, model and level, pin and archive, and its `/tree` branches. */
const SessionRowsV1 = defineTable("sessions", {
	version: 1,
	columns: {
		session: hostColumn(SessionHost),
		cwd: columnStr(),
		env: columnOpt(columnStr()),
		title: columnStr(),
		/** An explicit title (given at creation or renamed): automatic titles never replace it (Pi Mobile's). */
		titleEdited: columnBool(),
		createdAt: columnInt(),
		updatedAt: columnInt(),
		archivedAt: columnOpt(columnInt()),
		pinned: columnBool(),
		model: jsonColumn(ModelRefSchema, { version: 1 }),
		thinkingLevel: columnStr(),
		/** The current main conversation: 1, or the `/tree` branch the session continues in (`docs/tree.md`). */
		main: columnInt(),
		branches: jsonColumn(arr(BranchSchemaV5), { version: 1 }),
	},
	key: ["session"],
});

/** 2: a branch's `parent`; version 1's branches have none, so they read as they are. */
export const SessionRows = evolveTable(SessionRowsV1, (t) =>
	t.json(
		"branches",
		// A version 1 cell is a valid version 2 one: `parent` is optional (the column checks the result).
		jsonColumn(arr(BranchSchema), { version: 2, migrate: (old) => old as Branch[] }),
	),
);
export type SessionTable = TableOf<typeof SessionRows>;
export type SessionRow = SessionTable extends Table<infer C, readonly string[]> ? RowOf<C> : never;

/** The sidebar's order: most recent activity first. */
export const BY_ACTIVITY = query(SessionRows).orderBy((row) => row.updatedAt, "desc");

/**
 * The most rows the catalog keeps live (its `sessions` state): every session, archived ones included. A live query
 * needs a bound; the catalog re-read every row on each write before it was a table, so this costs no more.
 */
export const CATALOG_WINDOW = 100_000;

/** An automatic title: the first user message, line breaks as spaces, its first 100 characters (as Pi Mobile). */
const AUTO_TITLE = 100;

/** A row as the contract's `Session`. */
export function sessionOf(row: SessionRow): Session {
	return {
		id: row.session.params.id,
		cwd: row.cwd,
		env: row.env ?? null,
		title: row.title,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		archivedAt: row.archivedAt ?? null,
		pinned: row.pinned,
		model: row.model,
		thinkingLevel: row.thinkingLevel,
		main: row.main,
		branches: row.branches,
	};
}

/** `firstUserText` as an automatic title, or undefined when it gives none. */
export function automaticTitle(firstUserText: string | undefined): string | undefined {
	const title = firstUserText?.replace(/[\r\n]/g, " ").slice(0, AUTO_TITLE);
	return title === "" ? undefined : title;
}

/** The catalog's change of one row (`Catalog.update`). */
export type CatalogChange = {
	readonly title?: string;
	readonly cwd?: string;
	readonly env?: string | null;
	readonly pinned?: boolean;
	readonly archived?: boolean;
	readonly model?: Session["model"];
	readonly thinkingLevel?: string;
	readonly main?: number;
	readonly branches?: Session["branches"];
};

/**
 * Writes `change` to the row of session `id` in `tx` and returns the row as written; throws when there is none. A
 * rename is explicit; a new location counts as activity (Pi Mobile's setLocation).
 */
export async function updateRow(
	tx: Tx,
	table: SessionTable,
	id: string,
	change: CatalogChange,
	now: number,
): Promise<SessionRow> {
	const current = await tx.get(table, { session: SessionHost({ id }) });
	if (current === undefined) throw new Error("Session not found");
	const moved = change.cwd !== undefined || change.env !== undefined;
	const archivedAt =
		change.archived === undefined ? current.archivedAt : change.archived ? (current.archivedAt ?? now) : undefined;
	const env = change.env === undefined ? current.env : (change.env ?? undefined);
	const row: SessionRow = {
		session: current.session,
		cwd: change.cwd ?? current.cwd,
		...(env === undefined ? {} : { env }),
		title: change.title ?? current.title,
		titleEdited: change.title !== undefined || current.titleEdited,
		createdAt: current.createdAt,
		updatedAt: moved ? Math.max(current.updatedAt, now) : current.updatedAt,
		...(archivedAt === undefined ? {} : { archivedAt }),
		pinned: change.pinned ?? current.pinned,
		model: change.model ?? current.model,
		thinkingLevel: change.thinkingLevel ?? current.thinkingLevel,
		main: change.main ?? current.main,
		branches: change.branches ?? current.branches,
	};
	tx.put(table, row);
	return row;
}
