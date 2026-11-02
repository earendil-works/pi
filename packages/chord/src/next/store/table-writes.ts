// Table writes (slice 6a §5, §7, §9; S17; decisions "Writes carry their versions", "Index definitions are recorded"):
// the recorded form of every table write, the staged writes a transaction or an activation hands the commit step
// (their SQL rendered at staging, rule 8), and the appliers of the schema writes, which render DDL from the record.

import type { TableRecord } from "./catalog.ts";
import type { ColumnRecord } from "./columns.ts";
import type { SetNode, WhereNode } from "./expression.ts";
import type { EncodedRow, Scalar, StoredRow } from "./rows.ts";
import { versionColumn } from "./rows.ts";
import { columnSql, createIndexSql, createTableSql, dropIndexSql, quote, type Statement } from "./sql.ts";
import type { StagedWrite, Step } from "./step.ts";
import type { TableDefinition } from "./table.ts";
import type { AlterEdit, TableEdit } from "./table-history.ts";

/** A key as writes record it: the key columns' stored values. */
export type StoredKey = { readonly [column: string]: Scalar };

/** `json(...)` columns' versions written by a write, by column. */
export type ColumnVersions = { readonly [column: string]: number };

/** The table writes as the outbox and archives record them. */
export type TableWrite =
	| {
			readonly kind: "table";
			readonly table: string;
			readonly version: number;
			readonly state: "ready" | "migrating";
			readonly columns: { readonly [name: string]: ColumnRecord };
			readonly key: readonly string[];
			readonly fingerprint: string;
	  }
	| { readonly kind: "index"; readonly table: string; readonly name: string; readonly columns: readonly string[] }
	| { readonly kind: "dropIndex"; readonly table: string; readonly name: string }
	/** A column edit of the migration to `version`; DDL rendered from it. */
	| { readonly kind: "alter"; readonly table: string; readonly version: number; readonly edit: AlterEdit }
	| {
			readonly kind: "put";
			readonly table: string;
			readonly row: StoredRow;
			/** The row's eager-step version (the table's version at the `put`). */
			readonly version: number;
			readonly columns: ColumnVersions;
	  }
	| {
			readonly kind: "update";
			readonly table: string;
			readonly key: StoredKey;
			readonly set: SetNode;
			readonly columns: ColumnVersions;
			readonly count: number;
			/** A migration's data step: the version it stamps as the row's `$v` (a plugin's `update` never does). */
			readonly version?: number;
	  }
	| { readonly kind: "delete"; readonly table: string; readonly key: StoredKey; readonly count: number }
	| {
			readonly kind: "updateWhere";
			readonly table: string;
			readonly where: WhereNode;
			readonly set: SetNode;
			readonly columns: ColumnVersions;
			readonly count: number;
			/** A migration's `update` step: the version it stamps as the rows' `$v`. */
			readonly version?: number;
	  }
	| { readonly kind: "deleteWhere"; readonly table: string; readonly where: WhereNode; readonly count: number };

/** The versions of the `json(...)` columns of `definition` that `set` writes, which its statement stamps. */
export function jsonVersions(definition: TableDefinition, set: SetNode): ReadonlyMap<string, number> {
	const versions = new Map<string, number>();
	for (const name of Object.keys(set)) {
		const column = definition.byName.get(name)!;
		if (column.type === "json") versions.set(name, column.json.version);
	}
	return versions;
}

/** The `columns` a write records: the versions of the `json(...)` columns it sets to a value (a clear has none). */
export function recordedVersions(set: SetNode, versions: ReadonlyMap<string, number>): ColumnVersions {
	const columns: { [column: string]: number } = {};
	for (const [column, version] of versions) if (set[column] !== null) columns[column] = version;
	return columns;
}

/** The `table` write. */
export type TableDefinitionWrite = Extract<TableWrite, { readonly kind: "table" }>;

/** Stages a `table` write: the table created when the store does not have it yet, its record replaced otherwise. */
export function stageTable(write: TableDefinitionWrite): StagedWrite {
	return { order: "write", apply: async (step) => [await applyTable(step, write)] };
}

/** Stages an `index` write. */
export function stageIndex(write: Extract<TableWrite, { readonly kind: "index" }>): StagedWrite {
	return { order: "write", apply: async (step) => [await applyIndex(step, write)] };
}

/** Stages one edit of the migration of `table` to `version` as its `alter`, `index` or `dropIndex` write. */
export function stageEdit(table: string, version: number, edit: TableEdit): StagedWrite {
	switch (edit.kind) {
		case "index":
			return stageIndex({ kind: "index", table, name: edit.name, columns: edit.columns });
		case "dropIndex": {
			const write = { kind: "dropIndex", table, name: edit.name } as const;
			return { order: "write", apply: async (step) => [await applyDropIndex(step, write)] };
		}
		default: {
			const write = { kind: "alter", table, version, edit } as const;
			return { order: "write", apply: async (step) => [await applyAlter(step, write)] };
		}
	}
}

/** Stages a `put` of an encoded row with its `INSERT OR REPLACE` (an upsert: the whole row replaced). */
export function stagePut(sql: string, table: string, row: EncodedRow, version: number): StagedWrite {
	const write: TableWrite = { kind: "put", table, row: row.row, version, columns: row.columns };
	return {
		order: "write",
		apply: async (step) => {
			await step.run(sql, ...row.params);
			return [write];
		},
	};
}

/**
 * Stages an `update` of one row by key; its count (0 for an absent key) is recorded, and `version` when the statement stamps
 * the row's `$v` (a migration's `rows` step).
 */
export function stageUpdate(
	statement: Statement,
	table: string,
	key: StoredKey,
	set: SetNode,
	columns: ColumnVersions,
	version?: number,
): StagedWrite {
	const stamped = version === undefined ? {} : { version };
	return counted(statement, (count) => ({ kind: "update", table, key, set, columns, count, ...stamped }));
}

/** Stages a `delete` of one row by key; its count is recorded. */
export function stageDelete(statement: Statement, table: string, key: StoredKey): StagedWrite {
	return counted(statement, (count) => ({ kind: "delete", table, key, count }));
}

/**
 * Stages an `updateWhere`: one statement, its count recorded (a replica affecting another count stops, S17), and `version`
 * when it stamps the rows' `$v` (a migration's `update` step).
 */
export function stageUpdateWhere(
	statement: Statement,
	table: string,
	where: WhereNode,
	set: SetNode,
	columns: ColumnVersions,
	version?: number,
): StagedWrite {
	const stamped = version === undefined ? {} : { version };
	return counted(statement, (count) => ({ kind: "updateWhere", table, where, set, columns, count, ...stamped }));
}

/** Stages a `deleteWhere`: one statement, its count recorded. */
export function stageDeleteWhere(statement: Statement, table: string, where: WhereNode): StagedWrite {
	return counted(statement, (count) => ({ kind: "deleteWhere", table, where, count }));
}

function counted(statement: Statement, record: (count: number) => TableWrite): StagedWrite {
	return {
		order: "write",
		apply: async (step) => [record(await step.runCounted(statement.sql, ...statement.params))],
	};
}

/** Applies a `table` write: `CREATE TABLE` when the store does not have the table yet, then its record. */
export async function applyTable(step: Step, write: TableDefinitionWrite): Promise<TableWrite> {
	const existing = step.table(write.table);
	if (existing === undefined) await step.run(createTableSql(write.table, write.columns, write.key));
	const { table, version, state, columns, key, fingerprint } = write;
	step.tables.set(table, { table, version, state, columns, key, fingerprint, indexes: existing?.indexes ?? {} });
	return write;
}

/** Applies an `index` write: `CREATE INDEX` and the record's index. */
export async function applyIndex(
	step: Step,
	write: Extract<TableWrite, { readonly kind: "index" }>,
): Promise<TableWrite> {
	const existing = recorded(step, write.table);
	await step.run(createIndexSql(write.table, write.name, write.columns, existing.key));
	step.tables.set(write.table, { ...existing, indexes: { ...existing.indexes, [write.name]: write.columns } });
	return write;
}

/** Applies a `dropIndex` write: `DROP INDEX` and the record without it. */
export async function applyDropIndex(
	step: Step,
	write: Extract<TableWrite, { readonly kind: "dropIndex" }>,
): Promise<TableWrite> {
	const existing = recorded(step, write.table);
	await step.run(dropIndexSql(write.table, write.name));
	const { [write.name]: _dropped, ...indexes } = existing.indexes;
	step.tables.set(write.table, { ...existing, indexes });
	return write;
}

/** Applies an `alter` write: its DDL (a `json(...)` column's version column follows it) and the record's change. */
export async function applyAlter(
	step: Step,
	write: Extract<TableWrite, { readonly kind: "alter" }>,
): Promise<TableWrite> {
	const existing = recorded(step, write.table);
	const { edit } = write;
	const id = quote(write.table);
	switch (edit.kind) {
		case "rename": {
			const json = existing.columns[edit.from]?.type === "json";
			await step.run(`ALTER TABLE ${id} RENAME COLUMN ${quote(edit.from)} TO ${quote(edit.to)}`);
			if (json) {
				const [from, to] = [versionColumn(edit.from), versionColumn(edit.to)];
				await step.run(`ALTER TABLE ${id} RENAME COLUMN ${quote(from)} TO ${quote(to)}`);
			}
			const rename = (column: string): string => (column === edit.from ? edit.to : column);
			const columns = Object.entries(existing.columns).map(([name, column]) => [rename(name), column] as const);
			const indexes = Object.entries(existing.indexes).map(([name, on]) => [name, on.map(rename)] as const);
			step.tables.set(write.table, {
				...existing,
				columns: Object.fromEntries(columns),
				key: existing.key.map(rename),
				indexes: Object.fromEntries(indexes),
			});
			break;
		}
		case "add":
			for (const definition of columnSql(edit.name, edit.column)) {
				await step.run(`ALTER TABLE ${id} ADD COLUMN ${definition}`);
			}
			step.tables.set(write.table, { ...existing, columns: { ...existing.columns, [edit.name]: edit.column } });
			break;
		case "drop": {
			const json = existing.columns[edit.name]?.type === "json";
			await step.run(`ALTER TABLE ${id} DROP COLUMN ${quote(edit.name)}`);
			if (json) await step.run(`ALTER TABLE ${id} DROP COLUMN ${quote(versionColumn(edit.name))}`);
			const { [edit.name]: _dropped, ...columns } = existing.columns;
			step.tables.set(write.table, { ...existing, columns });
			break;
		}
		case "json":
			step.tables.set(write.table, { ...existing, columns: { ...existing.columns, [edit.name]: edit.column } });
			break;
	}
	return write;
}

/** The record of `table` in `step`; a write for a table the store does not have fails the step. */
function recorded(step: Step, table: string): TableRecord {
	const record = step.table(table);
	// Memory and disk disagree: the step fails, which stops the store.
	if (record === undefined) throw new Error(`table ${table}: not in the store`);
	return record;
}
