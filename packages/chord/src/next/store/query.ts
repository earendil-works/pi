// Queries (decision "Query runner"; slice 6a §6, rule 17): `query(Table).where(…).orderBy(…)` as immutable data
// (the condition compiled when given, the order with the key appended as the tie-break), and the opaque cursors that
// continue a page, bound to the table, the order columns and the direction.

import type { SqliteValue } from "../../sqlite/index.ts";
import { invalid } from "../data/internal.ts";
import type { Columns, ColumnTypeOf, ValueOf } from "./columns.ts";
import { type ColumnRef, type Condition, compileWhere, type WhereNode } from "./expression.ts";
import { checkScalar } from "./rows.ts";
import type { Order } from "./sql.ts";
import type { TableDefinition } from "./table.ts";

/** The column references a table's callbacks get: `e.path`, `e.at`. */
export type ColumnRefs<C extends Columns> = {
	readonly [K in keyof C & string]: ColumnRef<ValueOf<C[K]>, ColumnTypeOf<C[K]>>;
};

/** A query of `table`: its rows, in key order. */
export function query<C extends Columns, K extends readonly string[]>(table: TableDefinition<C, K>): Query<C, K> {
	return new Query(table, undefined, [], undefined);
}

/**
 * An immutable query of one table: an optional condition (several `where`s are `and`ed) and an order (`orderBy`
 * columns, one direction, the key appended unless already there).
 */
export class Query<C extends Columns = Columns, K extends readonly string[] = readonly string[]> {
	readonly table: TableDefinition<C, K>;
	readonly condition: WhereNode | undefined;
	readonly #orderBy: readonly string[];
	readonly #direction: "asc" | "desc" | undefined;

	constructor(
		table: TableDefinition<C, K>,
		condition: WhereNode | undefined,
		orderBy: readonly string[],
		direction: "asc" | "desc" | undefined,
	) {
		this.table = table;
		this.condition = condition;
		this.#orderBy = orderBy;
		this.#direction = direction;
	}

	/** This query with `fn`'s condition too. */
	where(fn: (row: ColumnRefs<C>) => Condition): Query<C, K> {
		// The refs are the table's columns, typed by `C`.
		const compiled = compileWhere(this.table, fn(this.table.refs as ColumnRefs<C>), "where");
		const condition = this.condition === undefined ? compiled : { and: [this.condition, compiled] };
		return new Query(this.table, condition, this.#orderBy, this.#direction);
	}

	/**
	 * This query ordered by `fn`'s column next (a non-`opt` `str` or `int` one), in `direction`: one direction per
	 * query, no column twice (`invalid/args`).
	 */
	orderBy(
		fn: (row: ColumnRefs<C>) => ColumnRef<unknown, "str" | "int">,
		direction: "asc" | "desc" = "asc",
	): Query<C, K> {
		const table = this.table;
		// The refs are `C`'s columns; what the plugin's callback returns is checked below.
		const ref = fn(table.refs as ColumnRefs<C>) as ColumnRef | undefined;
		const column = table.byName.get(ref?.column ?? "");
		if (column === undefined || column.optional || (column.type !== "str" && column.type !== "int")) {
			throw invalid("args", `${table.name}: orderBy: expected a non-opt str() or int() column`);
		}
		if (this.#orderBy.includes(column.name)) throw invalid("args", `${table.name}: orderBy: "${column.name}" twice`);
		if (this.#direction !== undefined && this.#direction !== direction) {
			throw invalid("args", `${table.name}: orderBy: one direction per query`);
		}
		return new Query(table, this.condition, [...this.#orderBy, column.name], direction);
	}

	/** The order of its rows: the `orderBy` columns, then the key columns not among them. */
	get order(): Order {
		const columns = [...this.#orderBy, ...this.table.key.filter((column) => !this.#orderBy.includes(column))];
		return { columns, direction: this.#direction ?? "asc" };
	}
}

/** The cursor of the position after a row with the order values `values` in the table named `table` (its SQL name). */
export function encodeCursor(table: string, order: Order, values: readonly SqliteValue[]): string {
	const json = JSON.stringify({ t: table, o: order.columns, d: order.direction, v: values });
	let binary = "";
	for (const byte of new TextEncoder().encode(json)) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * The order values of `cursor` (a trust boundary: an app hands it back): one made for `table`'s `order` (any
 * condition) in the table named `sqlName` (another object's table of the same definition is another table), each value
 * of its column's type; `invalid/args` otherwise.
 */
export function decodeCursor(table: TableDefinition, sqlName: string, order: Order, cursor: unknown): SqliteValue[] {
	const refuse = (): never => {
		throw invalid("args", `${table.name}: the cursor is not one of this table's order`);
	};
	if (typeof cursor !== "string") return refuse();
	let decoded: unknown;
	try {
		const binary = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
		decoded = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))),
		);
	} catch {
		return refuse();
	}
	// Wire input: every field is checked below.
	const { t, o, d, v } = (decoded ?? {}) as { t?: unknown; o?: unknown; d?: unknown; v?: unknown };
	if (t !== sqlName || d !== order.direction || JSON.stringify(o) !== JSON.stringify(order.columns)) refuse();
	if (!Array.isArray(v) || v.length !== order.columns.length) return refuse();
	return order.columns.map((name, index) => {
		const column = table.byName.get(name)!;
		// Order columns are non-opt `str` or `int` (checked when the query was built).
		return checkScalar(column.type as "str" | "int", v[index], `${table.name}: cursor`) as string | number;
	});
}
