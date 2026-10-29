// The applier (slice 6a §13, slice 6b §1.6): recorded writes applied as they were recorded, inside a backend
// transaction, checked against the store's own records (a trust boundary: archives, a replica's batches). One code
// path for import, bootstrap and batch apply, for every write kind; a recorded count the store does not reproduce
// stops applying (`Diverged`, S17).

import type { SqliteValue } from "../../sqlite/index.ts";
import { checkName } from "../contracts/internal.ts";
import { invalid } from "../data/internal.ts";
import type { TableRecord } from "./catalog.ts";
import { COLUMN_NAME, type ColumnRecord } from "./columns.ts";
import {
	type DocumentContent,
	type DocumentRecord,
	type DocumentWrite,
	insertDocument,
	insertRevision,
	type RevisionContent,
	readDocument,
	retireRecord,
	writeContent,
} from "./engine.ts";
import type { ExprNode, SetNode, WhereNode } from "./expression.ts";
import { checkScalar, ROW_VERSION, toSqlite, versionColumn } from "./rows.ts";
import { recordedPut, TableSql } from "./sql.ts";
import type { Step } from "./step.ts";
import { INDEX_NAME } from "./table.ts";
import { applyAlter, applyDropIndex, applyIndex, applyTable, type StoredKey, type TableWrite } from "./table-writes.ts";
import type { StoreWrite } from "./writes.ts";

/** A recorded write the store does not reproduce (a count, a revision): applying stops, the store diverged (S17). */
export class Diverged extends Error {}

/** Applies `write` in `step`; a write the records refuse throws `invalid/args`, one they do not reproduce `Diverged`. */
export async function applyWrite(step: Step, write: StoreWrite, what: string): Promise<void> {
	switch (write.kind) {
		case "table":
			checkTable(write, what);
			await applyTable(step, write);
			return;
		case "index":
			checkIndex(recordOf(step, write.table, what), write, what);
			await applyIndex(step, write);
			return;
		case "dropIndex":
			if (!Object.hasOwn(recordOf(step, write.table, what).indexes, write.name)) {
				throw invalid("args", `${what}: no index ${JSON.stringify(write.name)}`);
			}
			await applyDropIndex(step, write);
			return;
		case "alter":
			checkAlter(recordOf(step, write.table, what), write, what);
			await applyAlter(step, write);
			return;
		case "put": {
			const record = recordOf(step, write.table, what);
			const { sql, physical } = recordedPut(write.table, record.columns);
			await step.run(sql, ...putParams(record, write, physical, what));
			return;
		}
		case "update":
		case "delete":
		case "updateWhere":
		case "deleteWhere":
			return applyCounted(step, write, what);
		default:
			return applyDocument(step, write, what);
	}
}

/** Applies a document write: a creation, a change or a retirement on its recorded revision, an archive's revision. */
async function applyDocument(step: Step, write: DocumentWrite, what: string): Promise<void> {
	switch (write.kind) {
		case "document.create":
			await insertDocument(step, write.record, write.base === undefined ? undefined : json(write.base.value, what));
			return;
		case "document.revision": {
			const { content } = write;
			await insertRevision(step, write.id, write.seq, content.kind, content.version, contentText(content, what));
			return;
		}
		case "document.change": {
			const record = await liveAt(step, write.id, write.revision, what);
			const { content } = write;
			const text = contentText(content, what);
			await writeContent(step, write.id, record.history, write.revision, content, text);
			return;
		}
		case "document.retire":
			await retireRecord(step, await liveAt(step, write.id, write.revision, what));
			return;
	}
}

/** A content's stored text: a base's value or a delta's ops, checked as JSON. */
function contentText(content: DocumentContent | RevisionContent, what: string): string {
	return json(content.kind === "base" ? content.value : content.ops, what);
}

/** The live record `id` at `revision`; another revision, or none, is a divergence. */
async function liveAt(step: Step, id: number, revision: number, what: string): Promise<DocumentRecord> {
	const record = await readDocument(step, id);
	if (record === undefined || record.retiredAt !== undefined || record.revision !== revision) {
		throw new Diverged(`${what}: document ${id} is not live at revision ${revision}`);
	}
	return record;
}

/** `value` serialized; one `JSON.stringify` cannot encode is refused. */
function json(value: unknown, what: string): string {
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch (error) {
		throw invalid("args", `${what}: not JSON (${String(error)})`);
	}
	if (text === undefined) throw invalid("args", `${what}: not JSON`);
	return text;
}

/**
 * Applies a counted table write: its statement rendered from the record's columns and the recorded `key`, `where` and
 * `set` (checked: only recorded columns, well-formed nodes), and its count compared with the recorded one.
 */
async function applyCounted(
	step: Step,
	write: Extract<TableWrite, { readonly kind: "update" | "delete" | "updateWhere" | "deleteWhere" }>,
	what: string,
): Promise<void> {
	const record = recordOf(step, write.table, what);
	const columns = Object.entries(record.columns).map(([name, column]) => ({ name, type: column.type }));
	const sql = new TableSql(write.table, columns, [], record.key);
	let statement: { readonly sql: string; readonly params: SqliteValue[] };
	switch (write.kind) {
		case "update":
			statement = sql.update(
				setOf(record, write, what),
				keyParams(record, write.key, what),
				versionsOf(record, write, what),
			);
			break;
		case "delete":
			statement = { sql: sql.delete, params: keyParams(record, write.key, what) };
			break;
		case "updateWhere":
			checkWhere(record, write.where, what);
			statement = sql.updateWhere(write.where, setOf(record, write, what), versionsOf(record, write, what));
			break;
		case "deleteWhere":
			checkWhere(record, write.where, what);
			statement = sql.deleteWhere(write.where);
			break;
	}
	const count = await step.runCounted(statement.sql, ...statement.params);
	if (count !== write.count) throw new Diverged(`${what}: changed ${count} rows, recorded ${write.count}`);
}

/** The recorded key as parameters in key order: exactly the key columns, each of its type. */
function keyParams(record: TableRecord, key: StoredKey, what: string): SqliteValue[] {
	if (Object.keys(key).length !== record.key.length) throw invalid("args", `${what}: not a key of ${record.table}`);
	return record.key.map((name) => {
		if (!Object.hasOwn(key, name)) throw invalid("args", `${what}: key column ${JSON.stringify(name)} is missing`);
		return toSqlite(checkScalar(scalarType(record.columns[name]!), key[name], `${what}: key`));
	});
}

/** A recorded `set` with the migration stamp `$v` when it carries one; key columns never change (rule 13). */
function setOf(
	record: TableRecord,
	write: Extract<TableWrite, { readonly kind: "update" | "updateWhere" }>,
	what: string,
): SetNode {
	const { set } = write;
	if (typeof set !== "object" || set === null || Object.keys(set).length === 0) {
		throw invalid("args", `${what}: an empty or malformed set`);
	}
	for (const [column, node] of Object.entries(set)) {
		if (!Object.hasOwn(record.columns, column) || record.key.includes(column)) {
			throw invalid("args", `${what}: set writes ${JSON.stringify(column)}, no non-key column`);
		}
		checkExpr(record, node, what);
	}
	return write.version === undefined ? set : { ...set, [ROW_VERSION]: write.version };
}

/** The `json(...)` versions a `set` stamps: the recorded ones, of `json(...)` columns it sets, up to theirs. */
function versionsOf(
	record: TableRecord,
	write: Extract<TableWrite, { readonly kind: "update" | "updateWhere" }>,
	what: string,
): Map<string, number> {
	const versions = new Map<string, number>();
	for (const [name, column] of Object.entries(record.columns)) {
		if (column.type !== "json" || !Object.hasOwn(write.set, name)) continue;
		// A clear stamps `NULL` whatever the version; a value stamps its recorded version.
		const version = write.columns[name] ?? column.version!;
		if (!Number.isSafeInteger(version) || version < 1 || version > column.version!) {
			throw invalid("args", `${what}: no readable version for ${JSON.stringify(name)}`);
		}
		versions.set(name, version);
	}
	return versions;
}

/** A scalar column's type; `json(...)` columns are not scalars. */
function scalarType(column: ColumnRecord): "str" | "int" | "num" | "bool" {
	return column.type === "json" ? "str" : column.type;
}

const COMPARISONS = ["eq", "ne", "lt", "lte", "gt", "gte"] as const;

/** A recorded condition: well-formed nodes over recorded scalar columns (and the row's `$v`). */
function checkWhere(record: TableRecord, node: unknown, what: string): asserts node is WhereNode {
	const refuse = (): never => {
		throw invalid("args", `${what}: a malformed condition`);
	};
	if (typeof node !== "object" || node === null || Object.keys(node).length !== 1) return refuse();
	const [[op, operand]] = Object.entries(node) as [[string, unknown]];
	const column = (name: unknown): void => {
		if (name === ROW_VERSION) return;
		if (typeof name !== "string" || record.columns[name] === undefined || record.columns[name]!.type === "json") {
			refuse();
		}
	};
	if (op === "and" || op === "or") {
		if (!Array.isArray(operand)) return refuse();
		for (const each of operand) checkWhere(record, each, what);
	} else if (op === "not") checkWhere(record, operand, what);
	else if (op === "isNull") column(operand);
	else if (op === "inArray" || op === "prefix" || (COMPARISONS as readonly string[]).includes(op)) {
		if (!Array.isArray(operand) || operand.length !== 2) return refuse();
		column(operand[0]);
		const values = op === "inArray" ? operand[1] : [operand[1]];
		if (!Array.isArray(values)) return refuse();
		for (const value of values) if (!isScalar(value) || (op === "prefix" && typeof value !== "string")) refuse();
	} else refuse();
}

const OPERATIONS = ["add", "sub", "max", "min", "concat", "coalesce"] as const;

/** A recorded expression: scalars, `null`, JSON literals, recorded columns and the vocabulary's operations. */
function checkExpr(record: TableRecord, node: unknown, what: string): asserts node is ExprNode {
	if (node === null || isScalar(node)) return;
	const refuse = (): never => {
		throw invalid("args", `${what}: a malformed expression`);
	};
	if (typeof node !== "object" || Object.keys(node).length !== 1) return refuse();
	const [[op, operand]] = Object.entries(node) as [[string, unknown]];
	if (op === "col") {
		if (typeof operand !== "string" || !Object.hasOwn(record.columns, operand)) refuse();
		return;
	}
	if (op === "json") return;
	if (!Array.isArray(operand)) return refuse();
	if ((OPERATIONS as readonly string[]).includes(op) && operand.length === 2) {
		for (const each of operand) checkExpr(record, each, what);
	} else if (op === "replacePrefix" && operand.length === 3) {
		checkExpr(record, operand[0], what);
		if (typeof operand[1] !== "string" || typeof operand[2] !== "string") refuse();
	} else if (op === "when" && operand.length === 3) {
		checkWhere(record, operand[0], what);
		checkExpr(record, operand[1], what);
		checkExpr(record, operand[2], what);
	} else refuse();
}

function isScalar(value: unknown): boolean {
	return (
		typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
	);
}

/** A recorded table's SQL name (two names joined by `:`, R2), columns, key and json versions, by the name rules. */
function checkTable(write: Extract<TableWrite, { readonly kind: "table" }>, what: string): void {
	const parts = write.table.split(":");
	if (parts.length !== 2) throw invalid("args", `${what}: table ${JSON.stringify(write.table)}: not owner:table`);
	try {
		for (const part of parts) checkName(part, `${what}: table name part`);
	} catch (error) {
		// `checkName` throws plain Errors.
		throw invalid("args", (error as Error).message);
	}
	const folded = new Set<string>();
	for (const [name, column] of Object.entries(write.columns)) {
		const where = `${what}: column ${JSON.stringify(name)}`;
		if (!COLUMN_NAME.test(name) || folded.has(name.toLowerCase()))
			throw invalid("args", `${where}: not a column name`);
		folded.add(name.toLowerCase());
		checkColumn(column, where);
	}
	if (write.key.length === 0) throw invalid("args", `${what}: the key has no column`);
	checkOrderColumns(write.columns, write.key, `${what}: the key`);
}

function checkColumn(column: ColumnRecord, what: string): void {
	const json = column.type === "json";
	if (json !== (column.version !== undefined) || json !== (column.fingerprint !== undefined)) {
		throw invalid("args", `${what}: a json(...) column has a version and a fingerprint, no other column has`);
	}
	if (column.default === undefined) return;
	if (json || column.optional) throw invalid("args", `${what}: only a non-opt scalar column has a default`);
	checkScalar(column.type, column.default, `${what}: the default`);
}

/** A recorded column edit of `record`'s next version or its own (the edits after a data step). */
function checkAlter(record: TableRecord, write: Extract<TableWrite, { readonly kind: "alter" }>, what: string): void {
	if (write.version !== record.version && write.version !== record.version + 1) {
		throw invalid("args", `${what}: an edit of version ${write.version} on version ${record.version}`);
	}
	const { edit } = write;
	const has = (name: string): boolean => Object.hasOwn(record.columns, name);
	const fresh = (name: string): boolean =>
		COLUMN_NAME.test(name) && !Object.keys(record.columns).some((each) => each.toLowerCase() === name.toLowerCase());
	const indexed = (name: string): boolean =>
		record.key.includes(name) || Object.values(record.indexes).some((columns) => columns.includes(name));
	const valid =
		edit.kind === "rename"
			? has(edit.from) && fresh(edit.to)
			: edit.kind === "add"
				? fresh(edit.name) && (edit.column.optional === true || edit.column.default !== undefined)
				: edit.kind === "drop"
					? has(edit.name) && !indexed(edit.name)
					: has(edit.name) && record.columns[edit.name]!.type === "json" && edit.column.type === "json";
	if (!valid) throw invalid("args", `${what}: an ${edit.kind} edit the table cannot take`);
	if (edit.kind === "add" || edit.kind === "json")
		checkColumn(edit.column, `${what}: column ${JSON.stringify(edit.name)}`);
}

/** `names` are distinct, recorded, non-`opt` `str` or `int` columns. */
function checkOrderColumns(
	columns: { readonly [name: string]: ColumnRecord },
	names: readonly string[],
	what: string,
): void {
	if (new Set(names).size !== names.length) throw invalid("args", `${what}: a column occurs twice`);
	for (const name of names) {
		const column = Object.hasOwn(columns, name) ? columns[name] : undefined;
		if (column === undefined || column.optional || (column.type !== "str" && column.type !== "int")) {
			throw invalid("args", `${what}: ${JSON.stringify(name)} is not a non-opt str or int column`);
		}
	}
}

function checkIndex(record: TableRecord, write: Extract<TableWrite, { readonly kind: "index" }>, what: string): void {
	if (!INDEX_NAME.test(write.name) || Object.hasOwn(record.indexes, write.name)) {
		throw invalid("args", `${what}: index ${JSON.stringify(write.name)}: not a new index name`);
	}
	checkOrderColumns(record.columns, write.columns, `${what}: index ${write.name}`);
}

/** The record of `table` in `step`; a write for a table not recorded is refused. */
function recordOf(step: Step, table: string, what: string): TableRecord {
	const record = step.table(table);
	if (record === undefined) throw invalid("args", `${what}: table ${JSON.stringify(table)} is not recorded`);
	return record;
}

/**
 * The parameters of a `put` in `physical` order, checked against the recorded columns: every non-`opt` column, no
 * other field, values of their types, `json(...)` cells as JSON (no plugin code runs) with a version up to the
 * column's, and `version` up to the table's.
 */
function putParams(
	record: TableRecord,
	write: Extract<TableWrite, { readonly kind: "put" }>,
	physical: readonly string[],
	what: string,
): SqliteValue[] {
	const { row, columns: versions, version } = write;
	for (const field of Object.keys(row)) {
		if (!Object.hasOwn(record.columns, field))
			throw invalid("args", `${what}: unknown column ${JSON.stringify(field)}`);
	}
	for (const field of Object.keys(versions)) {
		if (record.columns[field]?.type !== "json" || !Object.hasOwn(row, field)) {
			throw invalid(
				"args",
				`${what}: a version for ${JSON.stringify(field)}, which is no json(...) cell of the row`,
			);
		}
	}
	if (version > record.version) {
		throw invalid("args", `${what}: version ${version} is newer than the table's version ${record.version}`);
	}
	const cells = new Map<string, SqliteValue>();
	for (const [name, column] of Object.entries(record.columns)) {
		const where = `${what}: column ${JSON.stringify(name)}`;
		const value = row[name];
		// A row has no explicit `null`: an absent field is `NULL`; a `json(...)` cell's `null` is the JSON value.
		if (column.type === "json" ? !Object.hasOwn(row, name) : value === undefined) {
			if (!column.optional) throw invalid("args", `${where} is missing`);
			cells.set(name, null);
			continue;
		}
		if (column.type !== "json") {
			cells.set(name, toSqlite(checkScalar(column.type, value, where)));
			continue;
		}
		const version = versions[name];
		if (version === undefined || version > column.version!) throw invalid("args", `${where}: no readable version`);
		cells.set(name, json(value, where));
		cells.set(versionColumn(name), version);
	}
	return physical.map((name) => (name === ROW_VERSION ? version : (cells.get(name) ?? null)));
}
