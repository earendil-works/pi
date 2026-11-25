// Read plans (slice 14 §3.2, §3.3, §5): a query compiled for the tables it reads right now. The plan resolves each
// column set to the table bound to it, checks every column and match the query uses against that table (a trust
// boundary: conditions arrive as data, and a publisher's reload changes its table), lists the tables the read depends
// on with the columns that matter, and renders its statements: the rows of a range, a count, and the probe.

import { ChordError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import { indexPath, sameColumn } from "./column-set.ts";
import type { Column } from "./columns.ts";
import {
	checkMatch,
	checkNode,
	checkPair,
	columnsOf,
	type ExistsNode,
	existsIn,
	partnerName,
	type WhereNode,
} from "./expression.ts";
import type { Joined, Query } from "./query.ts";
import { versionColumn } from "./rows.ts";
import { type ConditionSql, type Order, quote, type Statement, whereSql } from "./sql.ts";
import type { TableDefinition } from "./table.ts";

/** The table a column set is bound to: its SQL name and the definition its owner declared. */
export type Bound = { readonly table: string; readonly definition: TableDefinition };

/** The store's bindings of column sets, by set name. */
export type Bindings = { get(set: string): Bound | undefined };

/** What a read hands its mapping: columns of the own table, and of the joined set. */
export type Projection = { readonly reads?: readonly string[]; readonly partnerReads?: readonly string[] };

/**
 * One use of a table by a read (a table may be used more than once): its role, the columns of it the read depends
 * on, and the own columns a written row of it pairs with (what the probe is limited by).
 */
export type Use = {
	readonly role: "own" | "joined" | "exists";
	/** The table's SQL name. */
	readonly table: string;
	/** The columns of the table a change of which may change the read's result. */
	readonly depends: ReadonlySet<string>;
	/** The columns a change of which may bring a row into the result that was not in it (not the mapped ones). */
	readonly enters: ReadonlySet<string>;
	/** The table's columns a written row is identified by: the key, or an `exists`' matched columns. */
	readonly pairedBy: readonly string[];
	/** The own columns equal to `pairedBy` (`undefined`: none, the pairing goes through another side). */
	readonly pairs: readonly string[] | undefined;
	/** Whether an equality on `pairs` is keyed in the own table: only then the probe is used. */
	readonly keyed: boolean;
	/** Whether `pairedBy` are key columns of the table: a row then pairs with the same own rows before and after. */
	readonly stable: boolean;
};

/** A position in a read's order: the values of its first order columns (all of them, or a leading part). */
export type Position = readonly SqliteValue[];

/** The rows a statement asks for: after `after`, through `through` (inclusive), at most `limit`. */
export type Range = { readonly after?: Position; readonly through?: Position; readonly limit: number };

/** A stored row as the backend returns it: own columns by name, the partner's as `<set>:<column>`. */
export type StoredRead = { readonly [column: string]: SqliteValue };

const OWN = "t";
const PARTNER = "p";
const NO_COLUMNS: readonly never[] = [];
const UNBOUNDED: Range = { limit: 0 };

/**
 * A query compiled against the store's bindings. Its statements select the columns the mapping gets, the own key,
 * the matched own columns and the order columns, so a run can keep the keys the skip test needs.
 */
export class ReadPlan {
	readonly query: Query;
	/** The own table's SQL name. */
	readonly table: string;
	readonly order: Order;
	readonly uses: readonly Use[];
	readonly #bindings: Bindings;
	readonly #sides: Sides;
	readonly #select: string;
	readonly #from: string;
	/** The condition rendered once, with its parameters; no text without a condition. */
	readonly #where: { readonly sql: string | undefined; readonly params: readonly SqliteValue[] };
	/** Its statements' texts by shape (`#text`). */
	readonly #texts = new Map<string, string>();

	/** `shape`: what the plan is read as. A count depends on its condition and match columns only (slice 14 §3.3). */
	constructor(query: Query, table: string, projection: Projection, shape: "rows" | "count", bindings: Bindings) {
		const { joined, condition } = query;
		this.query = query;
		this.table = table;
		this.order = query.order;
		this.#bindings = bindings;
		const sides = sidesOf(joined);
		this.#sides = sides;
		const partner = joined === undefined ? undefined : boundPartner(joined, bindings);
		checkExpected(query.expected, bindings);
		// A count reads no rows: nothing is mapped and nothing ordered.
		const counted = shape === "count";
		const reads = counted ? NO_COLUMNS : (projection.reads ?? query.table.columns.map(({ name }) => name));
		const partnerReads = counted ? NO_COLUMNS : (projection.partnerReads ?? [...(joined?.set.byName.keys() ?? [])]);
		const used = [...(condition === undefined ? [] : columnsOf(condition)), ...(counted ? [] : this.order.columns)];
		const fixed = condition === undefined ? new Set<string>() : fixedBy(condition);
		const what = `${query.table.name}: exists`;
		const tested = condition === undefined ? [] : existsUses(condition, (name) => query.column(name), bindings, what);
		const own = ownUse(
			query,
			table,
			used.filter((name) => !sides.isPartner(name)),
			reads,
		);
		const joinedUses = partner === undefined ? [] : [joinedUse(query, partner, used, partnerReads, fixed, sides)];
		this.uses = [own, ...joinedUses, ...tested.map((use) => pairedWithOwn(use, query, fixed, sides))];
		this.#select = selectList(
			query,
			this.uses,
			reads,
			partnerReads,
			counted ? NO_COLUMNS : this.order.columns,
			sides,
		);
		this.#from = fromClause(table, joined, partner);
		const params: SqliteValue[] = [];
		this.#where = { sql: condition === undefined ? undefined : whereSql(condition, params, this.#render()), params };
	}

	/** The rows of `range` in the plan's order. */
	select(range: Range): Statement {
		const sql = this.#text("select", range, NO_COLUMNS, (filter) => {
			const direction = this.order.direction === "asc" ? "ASC" : "DESC";
			const sorting = this.order.columns.map((name) => `${this.#sides.sql(name)} ${direction}`).join(", ");
			return `SELECT ${this.#select} FROM ${this.#from}${filter} ORDER BY ${sorting} LIMIT ?`;
		});
		return { sql, params: [...this.#bound(range), range.limit] };
	}

	/** `count(*)` of the rows matching the condition. */
	count(): Statement {
		const render = (filter: string): string => `SELECT count(*) AS count FROM ${this.#from}${filter}`;
		return { sql: this.#text("count", UNBOUNDED, NO_COLUMNS, render), params: this.#bound(UNBOUNDED) };
	}

	/**
	 * The probe (slice 14 §3.3): whether a row of `range` has `values` in the own columns `columns`. One row or none.
	 */
	probe(range: Range, columns: readonly string[], values: readonly SqliteValue[]): Statement {
		const sql = this.#text("probe", range, columns, (filter) => {
			const limited = columns.map((name) => `${OWN}.${quote(name)} = ?`).join(" AND ");
			return `SELECT 1 AS found FROM ${this.#from}${filter}${filter === "" ? " WHERE " : " AND "}${limited} LIMIT 1`;
		});
		return { sql, params: [...this.#bound(range), ...values] };
	}

	/**
	 * The text of one of its statements, rendered once per shape (which bounds the range has and how long, which
	 * columns a probe is limited by): a probe runs per written key and read, so only its parameters are built per call.
	 */
	#text(kind: string, range: Range, columns: readonly string[], render: (filter: string) => string): string {
		const key = `${kind}|${range.after?.length ?? "-"}|${range.through?.length ?? "-"}|${columns.join(",")}`;
		let text = this.#texts.get(key);
		if (text === undefined) {
			text = render(this.#filter(range));
			this.#texts.set(key, text);
		}
		return text;
	}

	/** The parameters of a statement's filter, in the order `#filter` renders them: the condition's, then the bounds'. */
	#bound(range: Range): SqliteValue[] {
		return [...this.#where.params, ...(range.after ?? NO_COLUMNS), ...(range.through ?? NO_COLUMNS)];
	}

	/** ` WHERE …` of the condition and the range's bounds (row-value comparisons over the leading order columns). */
	#filter(range: Range): string {
		const conditions: string[] = this.#where.sql === undefined ? [] : [this.#where.sql];
		const asc = this.order.direction === "asc";
		const bound = (position: Position, operator: string): void => {
			const columns = this.order.columns.slice(0, position.length).map(this.#sides.sql).join(", ");
			conditions.push(`(${columns}) ${operator} (${position.map(() => "?").join(", ")})`);
		};
		if (range.after !== undefined) bound(range.after, asc ? ">" : "<");
		if (range.through !== undefined) bound(range.through, asc ? "<=" : ">=");
		return conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
	}

	/** How the condition's columns and `exists` render: own and partner columns by alias, an `exists` as a subquery. */
	#render(): ConditionSql {
		const column = this.#sides.sql;
		return { column, exists: (node, params) => this.#existsSql(node, params, column, 0) };
	}

	#existsSql(node: ExistsNode, params: SqliteValue[], outer: (name: string) => string, depth: number): string {
		const [set, pairs, inner] = node;
		const alias = `e${depth}`;
		const column = (name: string): string => `${alias}.${quote(name)}`;
		const matched = pairs.map(([name, enclosing]) => `${column(name)} = ${outer(enclosing)}`);
		const render: ConditionSql = {
			column,
			exists: (nested, into) => this.#existsSql(nested, into, column, depth + 1),
		};
		if (inner !== null) matched.push(whereSql(inner, params, render));
		return `EXISTS (SELECT 1 FROM ${quote(served(this.#bindings, set).table)} AS ${alias} WHERE ${matched.join(" AND ")})`;
	}
}

/** The two sides of a query's column names: own columns as they are, a joined set's as `<set>:<column>`. */
type Sides = {
	isPartner(name: string): boolean;
	/** A partner column's name within its set. */
	strip(name: string): string;
	/** The column in the plan's SQL, by its side's alias. */
	sql(name: string): string;
};

function sidesOf(joined: Joined | undefined): Sides {
	const prefix = joined === undefined ? undefined : partnerName(joined.set.name, "");
	const isPartner = (name: string): boolean => prefix !== undefined && name.startsWith(prefix);
	const strip = (name: string): string => name.slice(prefix?.length ?? 0);
	return {
		isPartner,
		strip,
		sql: (name) => (isPartner(name) ? `${PARTNER}.${quote(strip(name))}` : `${OWN}.${quote(name)}`),
	};
}

/**
 * The table bound to the joined set, checked: the read matches the set's whole key as the bound table has it now (a
 * key that gained a column would pair one row with several), or it is not what the read was written for.
 */
function boundPartner(joined: Joined, bindings: Bindings): Bound {
	const { name } = joined.set;
	const bound = served(bindings, name);
	const { key } = exposed(bound, name);
	const matched = joined.pairs.map(([column]) => column);
	if (key.length !== matched.length || !key.every((column) => matched.includes(column))) {
		const now = `its key is (${key.join(", ")})`;
		throw invalid(
			"args",
			`column set "${name}" is joined by (${matched.join(", ")}), ${now}: not what this read was written for`,
		);
	}
	return bound;
}

/** Checks the set columns a query's `exists` were written for against the tables bound to their sets. */
function checkExpected(expected: Query["expected"], bindings: Bindings): void {
	for (const [set, columns] of expected) {
		const { byName } = exposed(served(bindings, set), set);
		for (const [name, column] of columns) checkColumn(column, byName.get(name), set, name);
	}
}

/** The use of the query's own table: `used` are the own columns of its condition and order. */
function ownUse(query: Query, table: string, used: readonly string[], reads: readonly string[]): Use {
	const matched = query.joined?.pairs.map(([, name]) => name) ?? NO_COLUMNS;
	const enters = new Set([...used, ...matched]);
	const { key } = query.table;
	return {
		role: "own",
		table,
		depends: new Set([...enters, ...reads]),
		enters,
		pairedBy: key,
		pairs: key,
		keyed: true,
		stable: true,
	};
}

/**
 * The use of the joined set's table, checked: every partner column the read uses is, in the bound table, what the
 * read's set declares.
 */
function joinedUse(
	query: Query,
	partner: Bound,
	used: readonly string[],
	partnerReads: readonly string[],
	fixed: ReadonlySet<string>,
	sides: Sides,
): Use {
	const { set, pairs } = query.joined!;
	const enters = new Set(used.filter(sides.isPartner).map(sides.strip));
	const depends = new Set([...enters, ...partnerReads, ...set.key]);
	const { byName } = exposed(partner, set.name);
	for (const name of depends) checkColumn(set.byName.get(name), byName.get(name), set.name, name);
	const matched = pairs.map(([, name]) => name);
	return {
		role: "joined",
		table: partner.table,
		depends,
		enters,
		pairedBy: set.key,
		pairs: matched,
		keyed: keyedBy(query.table, fixed, matched),
		stable: true,
	};
}

/**
 * The uses of the `exists` in `condition` (a condition of one side, whose columns `columnOf` knows), each checked
 * against the table bound to its set: the match rule, the matched columns' types, its inner condition's columns. An
 * outermost one's `pairs` are the enclosing columns it is matched to; one nested in another pairs with no own row.
 */
function existsUses(
	condition: WhereNode,
	columnOf: (name: string) => Column | undefined,
	bindings: Bindings,
	what: string,
): Use[] {
	return existsIn(condition).flatMap(([setName, pairs, inner]) => {
		const bound = served(bindings, setName);
		const set = exposed(bound, setName);
		const pairedBy = pairs.map(([name]) => name);
		checkMatch(set, pairedBy, `${what}(${setName})`);
		for (const [name, enclosing] of pairs) {
			const [column, outer] = [set.byName.get(name), columnOf(enclosing)];
			if (column === undefined || outer === undefined) {
				throw invalid("args", `${what}(${setName}): no column "${column === undefined ? name : enclosing}"`);
			}
			checkPair(setName, column, outer, `${what}(${setName})`);
		}
		if (inner !== null) checkNode(inner, set, `${what}(${setName})`);
		const depends = new Set([...pairedBy, ...(inner === null ? [] : columnsOf(inner))]);
		const use: Use = {
			role: "exists",
			table: bound.table,
			depends,
			enters: depends,
			pairedBy,
			pairs: pairs.map(([, enclosing]) => enclosing),
			keyed: false,
			stable: pairedBy.every((name) => bound.definition.key.includes(name)),
		};
		// One nested in this one is matched to this set's columns: it pairs with no own row.
		const within = inner === null ? [] : existsUses(inner, (name) => set.byName.get(name), bindings, what);
		return [use, ...within.map((nested): Use => ({ ...nested, pairs: undefined }))];
	});
}

/**
 * An `exists`' use with the own columns it pairs by: its enclosing columns when they are own ones; the join's own
 * columns when it is matched on the partner's key; none otherwise (the read runs then).
 */
function pairedWithOwn(use: Use, query: Query, fixed: ReadonlySet<string>, sides: Sides): Use {
	const toOwn = (name: string): string | undefined =>
		sides.isPartner(name) ? query.joined!.pairs.find(([key]) => key === sides.strip(name))?.[1] : name;
	const mapped = use.pairs?.map(toOwn);
	const pairs = mapped?.every((name) => name !== undefined) ? (mapped as string[]) : undefined;
	return { ...use, pairs, keyed: pairs !== undefined && keyedBy(query.table, fixed, pairs) };
}

/**
 * The select list: what the mapping gets (`reads`, `partnerReads`, each `json(...)` column with its version), and
 * what the store keeps of a row: the own key, the own columns paired with other tables, the order columns.
 */
function selectList(
	query: Query,
	uses: readonly Use[],
	reads: readonly string[],
	partnerReads: readonly string[],
	order: readonly string[],
	sides: Sides,
): string {
	const own = query.table;
	const selected = new Set([...reads, ...own.key, ...order.filter((name) => !sides.isPartner(name))]);
	for (const use of uses) for (const name of use.pairs ?? NO_COLUMNS) selected.add(name);
	const versions = reads.filter((name) => own.byName.get(name)?.type === "json").map(versionColumn);
	const partner = new Set([...partnerReads, ...order.filter(sides.isPartner).map(sides.strip)]);
	const set = query.joined?.set.name ?? "";
	return [
		...[...selected, ...versions].map((name) => `${OWN}.${quote(name)} AS ${quote(name)}`),
		...[...partner].map((name) => `${PARTNER}.${quote(name)} AS ${quote(partnerName(set, name))}`),
	].join(", ");
}

/** The tables a statement reads from. `CROSS JOIN` keeps SQLite from reordering: a read is driven from its own table. */
function fromClause(table: string, joined: Joined | undefined, partner: Bound | undefined): string {
	if (joined === undefined || partner === undefined) return `${quote(table)} AS ${OWN}`;
	const on = joined.pairs.map(([key, name]) => `${PARTNER}.${quote(key)} = ${OWN}.${quote(name)}`).join(" AND ");
	return `${quote(table)} AS ${OWN} CROSS JOIN ${quote(partner.table)} AS ${PARTNER} ON ${on}`;
}

/** The binding of `set`; a read over a set nobody serves fails `unavailable` and runs again when one appears. */
function served(bindings: Bindings, set: string): Bound {
	const bound = bindings.get(set);
	if (bound !== undefined) return bound;
	throw new ChordError({ code: "unavailable", message: `column set "${set}" is not served` });
}

/** The column set `bound`'s table exposes: the one named `set` (a binding is made from `exposes`). */
function exposed(bound: Bound, set: string): NonNullable<TableDefinition["exposes"]> {
	const found = bound.definition.exposes;
	if (found?.name === set) return found;
	throw new ChordError({ code: "unavailable", message: `column set "${set}" is not served` });
}

/** Refuses a column of a set the read was written for that the bound table has not, or has differently. */
function checkColumn(expected: Column | undefined, found: Column | undefined, set: string, name: string): void {
	if (expected !== undefined && found !== undefined && sameColumn(expected, found)) return;
	throw invalid("args", `column "${name}" of column set "${set}" is not what this read was written for`);
}

/** The own columns a condition fixes with `eq` or `inArray` in its top-level `and` terms. */
function fixedBy(node: WhereNode): Set<string> {
	if ("and" in node) return new Set(node.and.flatMap((each) => [...fixedBy(each)]));
	if ("eq" in node) return new Set([node.eq[0]]);
	return new Set("inArray" in node ? [node.inArray[0]] : []);
}

/**
 * Whether an equality on `columns` is keyed in `table`: together with the `fixed` columns before them they are a
 * leading prefix of its key or of one of its indexes.
 */
function keyedBy(table: TableDefinition, fixed: ReadonlySet<string>, columns: readonly string[]): boolean {
	const paths = [table.key, ...[...table.indexes.values()].map((index) => indexPath(index, table.key))];
	return paths.some((path) => {
		let covered = 0;
		for (const name of path) {
			if (columns.includes(name)) covered++;
			else if (!fixed.has(name)) break;
			if (covered === columns.length) return true;
		}
		return false;
	});
}
