// Queries (decision "Query runner"; slice 6a §6, rule 17; slice 14 §5, §6): `query(Table).where(…).orderBy(…)` as
// immutable data (the condition compiled when given, the order with the key appended as the tie-break), optionally
// joined with one row of another plugin's column set, and the opaque cursors that continue a page, bound to the
// table, the order columns and the direction.

import { invalid } from "../data/internal.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import type { ColumnSet } from "./column-set.ts";
import type { Column, Columns, ColumnTypeOf, ValueOf } from "./columns.ts";
import {
	type ColumnRef,
	type Condition,
	checkMatch,
	checkNode,
	checkPair,
	compileCondition,
	type Expected,
	joinedScope,
	type Match,
	partnerName,
	type Scope,
	tableScope,
	type WhereNode,
} from "./expression.ts";
import { checkScalar } from "./rows.ts";
import type { Order } from "./sql.ts";
import type { TableDefinition } from "./table.ts";

/** The column references a table's callbacks get: `e.path`, `e.at`. */
export type ColumnRefs<C extends Columns> = {
	readonly [K in keyof C & string]: ColumnRef<ValueOf<C[K]>, ColumnTypeOf<C[K]>>;
};

/** No joined set: a query's partner references are empty then. */
export type NoColumns = Record<never, never>;

/** The set a query joins: one row of it per own row, by the set's whole key. */
export type Joined = {
	readonly set: ColumnSet;
	/** The set's key columns and the own columns each is matched to, in key order. */
	readonly pairs: readonly (readonly [string, string])[];
};

/** A query of `table`: its rows, in key order. */
export function query<C extends Columns, K extends readonly string[]>(table: TableDefinition<C, K>): Query<C, K> {
	return new Query(table, undefined, [], undefined, undefined, NOTHING_EXPECTED);
}

const NOTHING_EXPECTED: ReadonlyMap<string, ReadonlyMap<string, Column>> = new Map();

/**
 * An immutable query of one table: an optional condition (several `where`s are `and`ed), an order (`orderBy`
 * columns, one direction, the key appended unless already there) and at most one joined set, whose columns (`J`) the
 * condition and the order may use too.
 */
export class Query<
	C extends Columns = Columns,
	K extends readonly string[] = readonly string[],
	J extends Columns = NoColumns,
> {
	readonly table: TableDefinition<C, K>;
	readonly condition: WhereNode | undefined;
	readonly joined: Joined | undefined;
	/** The set columns its `exists` were written for (`Expected`): checked when a read of it opens. */
	readonly expected: ReadonlyMap<string, ReadonlyMap<string, Column>>;
	readonly #orderBy: readonly string[];
	readonly #direction: "asc" | "desc" | undefined;

	constructor(
		table: TableDefinition<C, K>,
		condition: WhereNode | undefined,
		orderBy: readonly string[],
		direction: "asc" | "desc" | undefined,
		joined: Joined | undefined,
		expected: ReadonlyMap<string, ReadonlyMap<string, Column>>,
	) {
		this.table = table;
		this.condition = condition;
		this.joined = joined;
		this.expected = expected;
		this.#orderBy = orderBy;
		this.#direction = direction;
	}

	/** This query with `fn`'s condition too; `partner` are the joined set's columns. */
	where(fn: (row: ColumnRefs<C>, partner: ColumnRefs<J>) => Condition): Query<C, K, J> {
		// A copy of what is expected so far: the compilation adds what this condition's `exists` use.
		const expected: Expected = new Map([...this.expected].map(([set, columns]) => [set, new Map(columns)]));
		const compiled = compileCondition(this.#scope(), fn(...this.#refs()), "where", expected);
		return this.#and(compiled, expected);
	}

	/**
	 * This query with a condition handed over as data (`compile(set, …)`, slice 14 §6): over the own table when it
	 * exposes `set`, over the partner when `set` is joined. A trust boundary: `node` is whatever arrived as an
	 * argument, and the whole of it is checked first.
	 */
	whereNode(set: ColumnSet, node: unknown): Query<C, K, J> {
		const what = `${this.table.name}: whereNode(${set.name})`;
		checkNode(node, set, what);
		if (this.joined?.set.name === set.name)
			return this.#and(renamed(node, (column) => partnerName(set.name, column)));
		if (this.table.exposes?.name !== set.name) throw invalid("args", `${what}: the query has no side of that set`);
		return this.#and(node);
	}

	/**
	 * This query joined with the one row of `set` whose key equals `match`'s own columns: an inner join driven from
	 * the own table. The match covers the set's whole key; one set per query, and not the one the table exposes.
	 */
	join<S extends Columns>(set: ColumnSet<S>, match: (row: ColumnRefs<C>) => Match<S>): Query<C, K, S> {
		const table = this.table;
		const what = `${table.name}: join(${set.name})`;
		if (this.joined !== undefined) throw invalid("args", `${what}: a query joins one set`);
		if (table.exposes?.name === set.name) throw invalid("args", `${what}: the set is the table's own`);
		// The callback is a plugin's: what it returns is read as unknown data and checked.
		const given = match(table.refs as ColumnRefs<C>) as { readonly [column: string]: unknown };
		const own = tableScope(table, false);
		const pairs = Object.entries(given ?? {}).map(([name, ref]) => {
			const column = set.byName.get(name);
			// A reference the scope does not know (another table's, no reference at all) resolves to nothing.
			const matched = own.resolve(ref as ColumnRef);
			if (column === undefined || matched === undefined)
				throw invalid("args", `${what}: "${name}" is matched to no column`);
			checkPair(set.name, column, matched.column, what);
			return [name, matched.name] as const;
		});
		const names = pairs.map(([name]) => name);
		if (names.length !== set.key.length)
			throw invalid("args", `${what}: the match covers the whole key (${set.key.join(", ")})`);
		checkMatch({ name: set.name, byName: set.byName, key: set.key, indexes: new Map() }, names, what);
		const ordered = set.key.map((column) => pairs.find(([name]) => name === column)!);
		const joined = { set, pairs: ordered };
		return new Query<C, K, S>(table, this.condition, this.#orderBy, this.#direction, joined, this.expected);
	}

	/**
	 * This query ordered by `fn`'s column next (a non-`opt` `str` or `int` one, of the table or of the joined set), in
	 * `direction`: one direction per query, no column twice (`invalid/args`).
	 */
	orderBy(
		fn: (row: ColumnRefs<C>, partner: ColumnRefs<J>) => ColumnRef<unknown, "str" | "int">,
		direction: "asc" | "desc" = "asc",
	): Query<C, K, J> {
		const table = this.table;
		// What the plugin's callback returns is checked below.
		const ref = fn(...this.#refs()) as ColumnRef | undefined;
		const resolved = ref === undefined ? undefined : this.#scope().resolve(ref);
		const column = resolved?.column;
		if (column === undefined || column.optional || (column.type !== "str" && column.type !== "int")) {
			throw invalid("args", `${table.name}: orderBy: expected a non-opt str() or int() column`);
		}
		const name = resolved!.name;
		if (this.#orderBy.includes(name)) throw invalid("args", `${table.name}: orderBy: "${name}" twice`);
		if (this.#direction !== undefined && this.#direction !== direction) {
			throw invalid("args", `${table.name}: orderBy: one direction per query`);
		}
		return new Query(table, this.condition, [...this.#orderBy, name], direction, this.joined, this.expected);
	}

	/** The order of its rows: the `orderBy` columns, then the key columns not among them. */
	get order(): Order {
		const columns = [...this.#orderBy, ...this.table.key.filter((column) => !this.#orderBy.includes(column))];
		return { columns, direction: this.#direction ?? "asc" };
	}

	/** The column `name` of its order or condition: the table's, or the joined set's (`<set>:<column>`). */
	column(name: string): Column | undefined {
		const joined = this.joined;
		const prefix = joined === undefined ? undefined : partnerName(joined.set.name, "");
		if (prefix !== undefined && name.startsWith(prefix)) return joined!.set.byName.get(name.slice(prefix.length));
		return this.table.byName.get(name);
	}

	#and(compiled: WhereNode, expected = this.expected): Query<C, K, J> {
		const condition = this.condition === undefined ? compiled : { and: [this.condition, compiled] };
		return new Query(this.table, condition, this.#orderBy, this.#direction, this.joined, expected);
	}

	#scope(): Scope {
		const own = tableScope(this.table, true);
		return this.joined === undefined ? own : joinedScope(own, this.joined.set);
	}

	/** The references its callbacks get: the table's columns, and the joined set's (none without a join). */
	#refs(): [ColumnRefs<C>, ColumnRefs<J>] {
		// The refs are the table's columns, typed by `C`, and the joined set's, typed by `J`.
		return [this.table.refs as ColumnRefs<C>, (this.joined?.set.refs ?? {}) as ColumnRefs<J>];
	}
}

/** `node` with every column of its own side renamed (an `exists`' inner condition is another side's). */
function renamed(node: WhereNode, rename: (column: string) => string): WhereNode {
	if ("and" in node) return { and: node.and.map((each) => renamed(each, rename)) };
	if ("or" in node) return { or: node.or.map((each) => renamed(each, rename)) };
	if ("not" in node) return { not: renamed(node.not, rename) };
	if ("isNull" in node) return { isNull: rename(node.isNull) };
	if ("exists" in node) {
		const [set, pairs, inner] = node.exists;
		return { exists: [set, pairs.map(([column, outer]) => [column, rename(outer)] as const), inner] };
	}
	// The remaining nodes are `{ [op]: [column, operand] }`, one entry each; `Object.entries` loses that.
	const [op, [column, operand]] = Object.entries(node)[0] as [string, readonly [string, unknown]];
	return { [op]: [rename(column), operand] } as unknown as WhereNode;
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
 * of its column's type (`column` finds a joined set's order columns); `invalid/args` otherwise.
 */
export function decodeCursor(
	table: TableDefinition,
	sqlName: string,
	order: Order,
	cursor: unknown,
	column: (name: string) => Column | undefined = (name) => table.byName.get(name),
): SqliteValue[] {
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
		const type = column(name)!.type;
		// Order columns are non-opt `str` or `int` (checked when the query was built).
		return checkScalar(type as "str" | "int", v[index], `${table.name}: cursor`) as string | number;
	});
}
