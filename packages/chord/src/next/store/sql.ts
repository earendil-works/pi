// SQL of declared tables (slice 6a §5, §6, §7): the DDL a table definition renders, and the statements of its reads
// and writes, generated from the compiled vocabulary with every value bound and every identifier quoted. Names were
// checked at declaration (and at import), so no `"` occurs in them and quoting is always safe.

import type { SqliteValue } from "../../sqlite/index.ts";
import type { Column, ColumnRecord } from "./columns.ts";
import type { ExprNode, SetNode, WhereNode } from "./expression.ts";
import { physicalColumns, ROW_VERSION, toSqlite, versionColumn } from "./rows.ts";
import { prefixUpperBound } from "./text.ts";

/** A statement and its parameters. */
export type Statement = { readonly sql: string; readonly params: SqliteValue[] };

/** An order of rows: the order columns (the key appended as the tie-break) and one direction. */
export type Order = { readonly columns: readonly string[]; readonly direction: "asc" | "desc" };

/** A quoted SQL identifier. */
export function quote(name: string): string {
	return `"${name}"`;
}

/** The SQL name of an owner's table: `<owner>:<table>` (R2), injective since neither part contains `:`. */
export function tableSqlName(owner: string, table: string): string {
	return `${owner}:${table}`;
}

/**
 * `CREATE TABLE` for `columns` (as recorded) and `key`: `STRICT`, the key as primary key (`WITHOUT ROWID`, except
 * for a single `int` key, which becomes the rowid: the fastest point lookups, and rows of any size), an `int`
 * column checked within ±(2^53 - 1) (rule 10), a `bool` one within 0 and 1, a `json(...)` one as `TEXT` with its
 * version column, and the row's `$v`.
 */
export function createTableSql(
	table: string,
	columns: { readonly [name: string]: ColumnRecord },
	key: readonly string[],
): string {
	const definitions = Object.entries(columns).flatMap(([name, column]) => columnSql(name, column));
	definitions.push(`${quote(ROW_VERSION)} INTEGER NOT NULL`);
	definitions.push(`PRIMARY KEY (${key.map(quote).join(", ")})`);
	const rowid = key.length === 1 && columns[key[0]!]!.type === "int";
	return `CREATE TABLE ${quote(table)} (${definitions.join(", ")}) STRICT${rowid ? "" : ", WITHOUT ROWID"}`;
}

const SAFE = Number.MAX_SAFE_INTEGER;

/** The definitions of one column: itself, and a `json(...)` column's version column. */
export function columnSql(name: string, column: ColumnRecord): string[] {
	const nullability = column.optional ? "" : " NOT NULL";
	const defaulted = column.default === undefined ? "" : ` DEFAULT ${literal(column.default)}`;
	const id = quote(name);
	switch (column.type) {
		case "str":
			return [`${id} TEXT${nullability}${defaulted}`];
		case "int":
			return [`${id} INTEGER${nullability}${defaulted} CHECK (${id} BETWEEN ${-SAFE} AND ${SAFE})`];
		case "num":
			return [`${id} REAL${nullability}${defaulted}`];
		case "bool":
			return [`${id} INTEGER${nullability}${defaulted} CHECK (${id} IN (0, 1))`];
		case "json":
			return [`${id} TEXT${nullability}`, `${quote(versionColumn(name))} INTEGER${nullability}`];
	}
}

/** A default as a SQL literal: declaration data (checked), which DDL cannot bind. */
function literal(value: string | number | boolean): string {
	if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
	return typeof value === "boolean" ? (value ? "1" : "0") : String(value);
}

/**
 * The physical columns of a recorded table in the order `RowCodec.physical` uses (`physicalColumns`), and its
 * whole-row `INSERT OR REPLACE` over them.
 */
export function recordedPut(
	table: string,
	columns: { readonly [name: string]: ColumnRecord },
): { readonly physical: readonly string[]; readonly sql: string } {
	const physical = physicalColumns(Object.entries(columns).map(([name, { type }]) => ({ name, type })));
	return { physical, sql: putSql(table, physical) };
}

/** `INSERT OR REPLACE` of a whole row over `physical` (`put` is an upsert). */
function putSql(table: string, physical: readonly string[]): string {
	return `INSERT OR REPLACE INTO ${quote(table)} (${physical.map(quote).join(", ")}) VALUES (${physical.map(() => "?").join(", ")})`;
}

/** `CREATE INDEX` named `<table>:<index>` over `columns`, the key appended (every index ends with it). */
export function createIndexSql(
	table: string,
	index: string,
	columns: readonly string[],
	key: readonly string[],
): string {
	const all = [...columns, ...key.filter((column) => !columns.includes(column))];
	return `CREATE INDEX ${quote(`${table}:${index}`)} ON ${quote(table)} (${all.map(quote).join(", ")})`;
}

/** `DROP INDEX` of `<table>:<index>`. */
export function dropIndexSql(table: string, index: string): string {
	return `DROP INDEX ${quote(`${table}:${index}`)}`;
}

/**
 * The statements of one table at one version, rendered once per table handle: the fixed ones as texts, the ones
 * over compiled conditions and `set`s on demand.
 */
export class TableSql {
	readonly table: string;
	/** The columns a read selects: the declared ones and each `json(...)` column's version. */
	readonly #select: string;
	readonly #byKey: string;
	/** `INSERT OR REPLACE` of a whole row, in `RowCodec.physical`'s order (`put` is an upsert). */
	readonly put: string;
	readonly get: string;
	readonly delete: string;

	constructor(
		table: string,
		columns: readonly Pick<Column, "name" | "type">[],
		physical: readonly string[],
		key: readonly string[],
	) {
		this.table = table;
		const id = quote(table);
		this.#select = [
			...columns.map(({ name }) => quote(name)),
			...columns.filter(({ type }) => type === "json").map(({ name }) => quote(versionColumn(name))),
		].join(", ");
		this.#byKey = key.map((column) => `${quote(column)} = ?`).join(" AND ");
		this.put = putSql(table, physical);
		this.get = `SELECT ${this.#select} FROM ${id} WHERE ${this.#byKey}`;
		this.delete = `DELETE FROM ${id} WHERE ${this.#byKey}`;
	}

	/** `SELECT` of `columns` of one row by key: a point lookup, without the `ORDER BY` and `LIMIT` of a page. */
	getColumns(columns: readonly string[]): string {
		return `SELECT ${columns.map(quote).join(", ")} FROM ${quote(this.table)} WHERE ${this.#byKey}`;
	}

	/** `UPDATE` of one row by key; `versions` gives each `json(...)` column's version to stamp. */
	update(set: SetNode, key: readonly SqliteValue[], versions: ReadonlyMap<string, number>): Statement {
		const params: SqliteValue[] = [];
		const assignments = setSql(set, versions, params);
		params.push(...key);
		return { sql: `UPDATE ${quote(this.table)} SET ${assignments} WHERE ${this.#byKey}`, params };
	}

	/** `UPDATE` of every row matching `where`. */
	updateWhere(where: WhereNode, set: SetNode, versions: ReadonlyMap<string, number>): Statement {
		const params: SqliteValue[] = [];
		const assignments = setSql(set, versions, params);
		const condition = whereSql(where, params);
		return { sql: `UPDATE ${quote(this.table)} SET ${assignments} WHERE ${condition}`, params };
	}

	/** `DELETE` of every row matching `where`. */
	deleteWhere(where: WhereNode): Statement {
		const params: SqliteValue[] = [];
		return { sql: `DELETE FROM ${quote(this.table)} WHERE ${whereSql(where, params)}`, params };
	}

	/**
	 * A page: rows matching `where` in `order`, after the order values `after` (row-value comparison; the key in the
	 * order makes it total), at most `limit` (bound); every column, or only `columns`.
	 */
	select(
		where: WhereNode | undefined,
		order: Order,
		after: readonly SqliteValue[] | undefined,
		limit: number,
		columns?: readonly string[],
	): Statement {
		const params: SqliteValue[] = [];
		const conditions: string[] = [];
		if (where !== undefined) conditions.push(whereSql(where, params));
		if (after !== undefined) {
			const columns = order.columns.map(quote).join(", ");
			conditions.push(`(${columns}) ${order.direction === "asc" ? ">" : "<"} (${after.map(() => "?").join(", ")})`);
			params.push(...after);
		}
		const filter = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
		const direction = order.direction === "asc" ? "ASC" : "DESC";
		const sorting = order.columns.map((column) => `${quote(column)} ${direction}`).join(", ");
		params.push(limit);
		const select = columns === undefined ? this.#select : columns.map(quote).join(", ");
		return { sql: `SELECT ${select} FROM ${quote(this.table)}${filter} ORDER BY ${sorting} LIMIT ?`, params };
	}

	/** `count(*)` of the rows matching `where`. */
	count(where: WhereNode | undefined): Statement {
		const params: SqliteValue[] = [];
		const filter = where === undefined ? "" : ` WHERE ${whereSql(where, params)}`;
		return { sql: `SELECT count(*) AS count FROM ${quote(this.table)}${filter}`, params };
	}
}

/** The assignments of `set`; a written `json(...)` column also stamps its version (a clear stamps `NULL`). */
function setSql(set: SetNode, versions: ReadonlyMap<string, number>, params: SqliteValue[]): string {
	const assignments: string[] = [];
	for (const [column, node] of Object.entries(set)) {
		assignments.push(`${quote(column)} = ${exprSql(node, params)}`);
		const version = versions.get(column);
		if (version !== undefined) {
			assignments.push(`${quote(versionColumn(column))} = ?`);
			params.push(node === null ? null : version);
		}
	}
	return assignments.join(", ");
}

function exprSql(node: ExprNode, params: SqliteValue[]): string {
	if (node === null) return "NULL";
	if (typeof node !== "object") {
		params.push(toSqlite(node));
		return "?";
	}
	if ("col" in node) return quote(node.col);
	if ("json" in node) {
		// Serialized once at staging already (rule 8): this cannot throw.
		params.push(JSON.stringify(node.json));
		return "?";
	}
	if ("when" in node) {
		const [condition, a, b] = node.when;
		return `(CASE WHEN ${whereSql(condition, params)} THEN ${exprSql(a, params)} ELSE ${exprSql(b, params)} END)`;
	}
	if ("replacePrefix" in node) {
		const [subject, from, to] = node.replacePrefix;
		const length = [...from].length;
		// SQLite's `substr` counts characters of UTF-8 text: code points, as the prefix's length does.
		// Parameters in the order their `?` occur in the text.
		const value = exprSql(subject, params);
		params.push(length, from, to);
		const rest = exprSql(subject, params);
		params.push(length + 1);
		const unchanged = exprSql(subject, params);
		return `(CASE WHEN substr(${value}, 1, ?) = ? THEN ? || substr(${rest}, ?) ELSE ${unchanged} END)`;
	}
	if ("coalesce" in node)
		return `coalesce(${exprSql(node.coalesce[0], params)}, ${exprSql(node.coalesce[1], params)})`;
	if ("add" in node) return `(${exprSql(node.add[0], params)} + ${exprSql(node.add[1], params)})`;
	if ("sub" in node) return `(${exprSql(node.sub[0], params)} - ${exprSql(node.sub[1], params)})`;
	if ("max" in node) return `max(${exprSql(node.max[0], params)}, ${exprSql(node.max[1], params)})`;
	if ("min" in node) return `min(${exprSql(node.min[0], params)}, ${exprSql(node.min[1], params)})`;
	return `(${exprSql(node.concat[0], params)} || ${exprSql(node.concat[1], params)})`;
}

const COMPARISONS = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;

/** A condition with its operands bound; SQL's `NULL` rules are the vocabulary's. */
export function whereSql(node: WhereNode, params: SqliteValue[]): string {
	if ("and" in node)
		return node.and.length === 0 ? "1" : `(${node.and.map((each) => whereSql(each, params)).join(" AND ")})`;
	if ("or" in node)
		return node.or.length === 0 ? "0" : `(${node.or.map((each) => whereSql(each, params)).join(" OR ")})`;
	if ("not" in node) return `(NOT ${whereSql(node.not, params)})`;
	if ("isNull" in node) return `${quote(node.isNull)} IS NULL`;
	if ("inArray" in node) {
		const [column, values] = node.inArray;
		params.push(JSON.stringify(values.map(toSqlite)));
		return `${quote(column)} IN (SELECT value FROM json_each(?))`;
	}
	if ("prefix" in node) {
		const [column, prefix] = node.prefix;
		const upper = prefixUpperBound(prefix);
		params.push(prefix);
		if (upper === undefined) return `${quote(column)} >= ?`;
		params.push(upper);
		return `(${quote(column)} >= ? AND ${quote(column)} < ?)`;
	}
	// The remaining nodes are the comparisons, one entry each; `Object.entries` loses that.
	const [op, [column, value]] = Object.entries(node)[0] as [
		keyof typeof COMPARISONS,
		readonly [string, string | number | boolean],
	];
	params.push(toSqlite(value));
	return `${quote(column)} ${COMPARISONS[op]} ?`;
}
