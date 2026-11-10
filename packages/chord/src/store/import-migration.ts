// Rows of an imported table brought to the version the store records (decision "Documents and table rows can belong
// to a host": imported content migrates as all data does; spec `docs/host-keyed/spec.md` §4): each row taken through
// the versions after the archive's as the eager migration takes stored rows (`table-migration.ts`): the edits before
// each data step, the step for a row below its version, the edits after it. Recorded versions stay exact: `$v` as the steps stamp it, `json(...)` cells at the
// version they were written with (a cell a step sets at the column's version then).

import type { Context } from "../context/index.ts";
import { invalid } from "../data/internal.ts";
import type { JsonValue } from "../json.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import type { TableRecord } from "./catalog.ts";
import { applySet, type EvaluatedRow, matches } from "./evaluate.ts";
import type { SetNode } from "./expression.ts";
import { ROW_VERSION, versionColumn } from "./rows.ts";
import type { TableDefinition } from "./table.ts";
import { historyOf, type TableEdit } from "./table-history.ts";
import { patchSet } from "./table-migration.ts";
import type { TableWrite } from "./table-writes.ts";

/** A recorded `put`. */
type Put = Extract<TableWrite, { readonly kind: "put" }>;

/**
 * `puts` of the archive's table `write` at the version `recorded` has, through `history` (the owner's newest
 * definition of the table): both versions must be in the history (a `migrating` archive's with a data step to resume).
 * Throws `invalid/args` otherwise; a data step that throws or returns a patch the version cannot take throws its error.
 * The archive's metadata is not compared: the importer checks every row against the recorded host column.
 */
export function migrateRows(
	write: Extract<TableWrite, { readonly kind: "table" }>,
	puts: readonly Put[],
	history: TableDefinition,
	recorded: TableRecord,
	context: Context,
): Put[] {
	const what = `importHostData: table ${write.table}`;
	const versions = historyOf(history);
	const from = versions.find((each) => each.version === write.version);
	const to = versions.find((each) => each.version === recorded.version);
	if (from === undefined || to === undefined) {
		throw invalid("args", `${what}: version ${write.version} or ${recorded.version} is not in its owner's history`);
	}
	if (write.state === "migrating" && from.evolution?.migration.step === undefined) {
		throw invalid("args", `${what}: version ${write.version} exported migrating has no data step to resume`);
	}
	const later = versions.filter((each) => each.version > from.version && each.version <= to.version);
	return puts.map((put) => migrateRow(put, write.state === "migrating" ? from : undefined, later, context));
}

/** A row in migration: its stored cells, its `json(...)` cells' versions and its `$v`. */
type Migrating = { row: EvaluatedRow; cells: { [column: string]: number }; version: number };

/** One row through `resumed`'s unfinished data step (an archive exported `migrating`), then each of `later`. */
function migrateRow(
	put: Put,
	resumed: TableDefinition | undefined,
	later: readonly TableDefinition[],
	context: Context,
): Put {
	const state: Migrating = { row: { ...put.row }, cells: { ...put.columns }, version: put.version };
	if (resumed !== undefined) {
		const { step, after } = resumed.evolution!.migration;
		runStep(state, resumed.version, step!, context);
		for (const edit of after) applyEdit(state, edit);
	}
	for (const definition of later) {
		// A later version always has its migration: it came from `evolveTable`.
		const { before, step, after } = definition.evolution!.migration;
		for (const edit of before) applyEdit(state, edit);
		if (step !== undefined) runStep(state, definition.version, step, context);
		for (const edit of after) applyEdit(state, edit);
	}
	return { ...put, row: state.row as Put["row"], version: state.version, columns: state.cells };
}

/** One column edit on a row, as its DDL changes a stored row. */
function applyEdit(state: Migrating, edit: TableEdit): void {
	const row = { ...state.row };
	switch (edit.kind) {
		case "rename":
			if (Object.hasOwn(row, edit.from)) row[edit.to] = row[edit.from];
			delete row[edit.from];
			if (Object.hasOwn(state.cells, edit.from)) state.cells[edit.to] = state.cells[edit.from]!;
			delete state.cells[edit.from];
			break;
		case "add":
			// A non-`opt` added column has a default, which existing rows get; an `opt(...)` one stays `NULL`.
			if (edit.column.default !== undefined) row[edit.name] = edit.column.default;
			break;
		case "drop":
			delete row[edit.name];
			delete state.cells[edit.name];
			break;
		default:
			// `json` changes no cell (cells migrate on access); `index` and `dropIndex` none either.
			return;
	}
	state.row = row;
}

/**
 * Version `v`'s data step on a row below it, stamping `v`: a `rows` patch on the row decoded with the step's table,
 * an `update` where its condition holds.
 */
function runStep(
	state: Migrating,
	v: number,
	step: NonNullable<NonNullable<TableDefinition["evolution"]>["migration"]["step"]>,
	context: Context,
): void {
	if (state.version >= v) return;
	const { table } = step;
	let set: SetNode;
	if (step.kind === "rows") set = patchSet(step, table.rows.decode(sqliteRow(state, table), context), v);
	else if (step.where === undefined || matches(step.where, state.row)) set = step.set;
	else return;
	state.row = applySet(set, state.row, table.name);
	for (const [name, node] of Object.entries(set)) {
		const column = table.byName.get(name)!;
		if (column.type !== "json") continue;
		if (node === null) delete state.cells[name];
		else state.cells[name] = column.json.version;
	}
	state.version = v;
}

/** The row as SQLite stores it in `table`'s layout (what `RowCodec.decode` reads). */
function sqliteRow(state: Migrating, table: TableDefinition): { [column: string]: SqliteValue } {
	const stored: { [column: string]: SqliteValue } = { [ROW_VERSION]: state.version };
	for (const column of table.columns) {
		const value = state.row[column.name];
		if (value === undefined) stored[column.name] = null;
		else if (column.type === "bool") stored[column.name] = value === true ? 1 : 0;
		else if (column.type === "json") {
			stored[column.name] = JSON.stringify(value as JsonValue);
			stored[versionColumn(column.name)] = state.cells[column.name] ?? null;
		} else stored[column.name] = value as string | number;
	}
	return stored;
}
