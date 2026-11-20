// The table expression language (slice 6a §6, §7; rules 10, 13, 14, 16; decision "Nullable columns and the `set`
// form"): the builders plugins write `where` and `set` with, and their compilation at staging into one data-only
// vocabulary (what the outbox and archives carry; `evaluate.ts` runs it in JavaScript, `sql.ts` renders it).

import type { Address, Optional } from "../contracts/index.ts";
import { invalid } from "../data/internal.ts";
import type { JsonValue } from "../json.ts";
import type { ColumnSet } from "./column-set.ts";
import {
	type Column,
	type Columns,
	type ColumnType,
	type ColumnTypeOf,
	columnRecord,
	type ValueOf,
} from "./columns.ts";
import type { HostColumn } from "./host-column.ts";
import { checkScalar, encodeCell, type Scalar } from "./rows.ts";
import type { TableDefinition } from "./table.ts";

/**
 * A compiled condition: column comparisons with checked operands, combined by `and`, `or`, `not`. A query's
 * condition may also test `exists` (slice 14 §5): `[set, [[setColumn, column], …], inner]`, true for a row when the
 * set's table has a row equal in the matched columns that satisfies `inner`. Writes take no `exists`. Untagged on
 * purpose: each node is told apart by its one key (`"and" in node`), as the stored format (outbox, archives) holds it.
 */
export type WhereNode =
	| { readonly eq: readonly [string, Scalar] }
	| { readonly ne: readonly [string, Scalar] }
	| { readonly lt: readonly [string, Scalar] }
	| { readonly lte: readonly [string, Scalar] }
	| { readonly gt: readonly [string, Scalar] }
	| { readonly gte: readonly [string, Scalar] }
	| { readonly inArray: readonly [string, readonly Scalar[]] }
	| { readonly isNull: string }
	| { readonly prefix: readonly [string, string] }
	| { readonly and: readonly WhereNode[] }
	| { readonly or: readonly WhereNode[] }
	| { readonly not: WhereNode }
	| { readonly exists: ExistsNode };

/** The data of an `exists`: the set's name, the matched pairs (set column, enclosing column), the inner condition. */
export type ExistsNode = readonly [string, readonly (readonly [string, string])[], WhereNode | null];

/**
 * A compiled value expression: a literal (`null` clears), a column, a `json(...)` cell, or an operation. Untagged on
 * purpose, as `WhereNode`: the stored format.
 */
export type ExprNode =
	| Scalar
	| null
	| { readonly col: string }
	| { readonly json: JsonValue }
	| { readonly add: readonly [ExprNode, ExprNode] }
	| { readonly sub: readonly [ExprNode, ExprNode] }
	| { readonly max: readonly [ExprNode, ExprNode] }
	| { readonly min: readonly [ExprNode, ExprNode] }
	| { readonly concat: readonly [ExprNode, ExprNode] }
	| { readonly coalesce: readonly [ExprNode, ExprNode] }
	| { readonly replacePrefix: readonly [ExprNode, string, string] }
	| { readonly when: readonly [WhereNode, ExprNode, ExprNode] };

/** A compiled `set`: the new value of each changed column, every right side evaluated against the row before. */
export type SetNode = { readonly [column: string]: ExprNode };

/** The comparison operators of a `WhereNode`. */
export type Comparison = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

/** The operations of an `ExprNode`. */
export type Operation = "add" | "sub" | "max" | "min" | "concat" | "coalesce" | "replacePrefix" | "when";

/** A value expression as a plugin builds it: `T` is its value, `K` its column type. Compiled when staged. */
export class Expression<T = unknown, K extends ColumnType = ColumnType> {
	readonly op: Operation | "col";
	readonly args: readonly unknown[];
	/** Type only. */
	declare readonly "~value"?: T;
	declare readonly "~type"?: K;

	constructor(op: Operation | "col", args: readonly unknown[]) {
		this.op = op;
		this.args = args;
	}
}

/**
 * A reference to a column of the row, as `(t) => …` callbacks get them. One of a column set (`Set.refs`) carries the
 * set's name: a condition names the side it means by it (a query's own table, a joined set, an `exists`).
 */
export class ColumnRef<T = unknown, K extends ColumnType = ColumnType> extends Expression<T, K> {
	readonly column: string;
	readonly set: string | undefined;

	constructor(column: string, set?: string) {
		super("col", [column]);
		this.column = column;
		this.set = set;
	}
}

/** A condition as a plugin builds it; compiled when staged or run. */
export class Condition {
	readonly op: Comparison | "inArray" | "isNull" | "prefix" | "and" | "or" | "not" | "exists" | "existsNode";
	readonly args: readonly unknown[];

	constructor(op: Condition["op"], args: readonly unknown[]) {
		this.op = op;
		this.args = args;
	}
}

/**
 * A `set` of a table with columns `C` and key `K`: new values of non-key columns, each a value or an expression of
 * the column's type; `undefined` clears an `opt(...)` column.
 */
export type SetOf<C extends Columns, K extends readonly string[]> = {
	readonly [P in Exclude<keyof C & string, K[number]>]?: C[P] extends Optional
		? ValueOf<C[P]> | Expression<ValueOf<C[P]>, ColumnTypeOf<C[P]>> | undefined
		: ValueOf<C[P]> | Expression<ValueOf<C[P]>, ColumnTypeOf<C[P]>>;
};

/** A scalar column type. */
type ScalarType = Exclude<ColumnType, "json">;

/** An operand of type `T` and column type `K`: an expression or a plain value. */
type Operand<T, K extends ColumnType> = Expression<T, K> | T;

/** A value `eq`, `ne` and `inArray` compare a column with: a scalar, or an address for a `host(...)` column. */
type Comparable = Scalar | Address;

/** The column equals `value` (`NULL` never matches). */
export function eq<T extends Comparable>(column: ColumnRef<T, ScalarType>, value: T): Condition {
	return new Condition("eq", [column, value]);
}

/** The column differs from `value` (`NULL` never matches). */
export function ne<T extends Comparable>(column: ColumnRef<T, ScalarType>, value: T): Condition {
	return new Condition("ne", [column, value]);
}

/** The column is below `value`. */
export function lt<T extends Scalar>(column: ColumnRef<T, ScalarType>, value: T): Condition {
	return new Condition("lt", [column, value]);
}

/** The column is at most `value`. */
export function lte<T extends Scalar>(column: ColumnRef<T, ScalarType>, value: T): Condition {
	return new Condition("lte", [column, value]);
}

/** The column is above `value`. */
export function gt<T extends Scalar>(column: ColumnRef<T, ScalarType>, value: T): Condition {
	return new Condition("gt", [column, value]);
}

/** The column is at least `value`. */
export function gte<T extends Scalar>(column: ColumnRef<T, ScalarType>, value: T): Condition {
	return new Condition("gte", [column, value]);
}

/** The column equals one of `values` (`[]` matches nothing). */
export function inArray<T extends Comparable>(column: ColumnRef<T, ScalarType>, values: readonly T[]): Condition {
	return new Condition("inArray", [column, values]);
}

/** The column is `NULL` (an `opt(...)` column without a value). */
export function isNull(column: ColumnRef<unknown, ScalarType>): Condition {
	return new Condition("isNull", [column]);
}

/** The text column starts with `prefix`, compared by code point (`""` matches every value). */
export function prefix(column: ColumnRef<string, "str">, prefix: string): Condition {
	return new Condition("prefix", [column, prefix]);
}

/** Every condition holds (`and()` always does). */
export function and(...conditions: Condition[]): Condition {
	return new Condition("and", conditions);
}

/** Some condition holds (`or()` never does). */
export function or(...conditions: Condition[]): Condition {
	return new Condition("or", conditions);
}

/** The condition does not hold (`NULL` stays `NULL`: it never matches). */
export function not(condition: Condition): Condition {
	return new Condition("not", [condition]);
}

/** The columns of a set matched to columns of the enclosing row: `{ setColumn: column }`. */
export type Match<C extends Columns> = {
	readonly [P in keyof C & string]?: ColumnRef<ValueOf<C[P]>, ColumnTypeOf<C[P]>>;
};

/**
 * `set`'s table has a row equal to the enclosing row in the matched columns (a leading prefix of the set's key or of
 * one of its declared indexes) that satisfies `inner`. In queries only.
 */
export function exists<C extends Columns>(
	set: ColumnSet<C>,
	match: Match<C>,
	inner?: (row: ColumnSet<C>["refs"]) => Condition,
): Condition {
	return new Condition("exists", [set, match, inner?.(set.refs)]);
}

/**
 * `exists` with its inner condition as data (`compile`'s result): for a condition handed over as an argument. A
 * trust boundary: `inner` is whatever arrived, and is checked whole before anything is rendered.
 */
export function existsNode<C extends Columns>(set: ColumnSet<C>, match: Match<C>, inner: unknown): Condition {
	return new Condition("existsNode", [set, match, inner]);
}

/** `a + b` over integers; a result outside ±(2^53 - 1) fails (rule 10). */
export function add(a: Operand<number, "int">, b: Operand<number, "int">): Expression<number, "int"> {
	return new Expression("add", [a, b]);
}

/** `a - b` over integers; a result outside ±(2^53 - 1) fails (rule 10). */
export function sub(a: Operand<number, "int">, b: Operand<number, "int">): Expression<number, "int"> {
	return new Expression("sub", [a, b]);
}

/** The larger of `a` and b` (`int` or `num`). */
export function max<K extends "int" | "num">(a: Operand<number, K>, b: Operand<number, K>): Expression<number, K> {
	return new Expression("max", [a, b]);
}

/** The smaller of `a` and `b` (`int` or `num`). */
export function min<K extends "int" | "num">(a: Operand<number, K>, b: Operand<number, K>): Expression<number, K> {
	return new Expression("min", [a, b]);
}

/** `a` followed by `b`. */
export function concat(a: Operand<string, "str">, b: Operand<string, "str">): Expression<string, "str"> {
	return new Expression("concat", [a, b]);
}

/** `value` with its prefix `from` replaced by `to`; a value without the prefix stays as it is. */
export function replacePrefix(value: Operand<string, "str">, from: string, to: string): Expression<string, "str"> {
	return new Expression("replacePrefix", [value, from, to]);
}

/** `a` unless it is `NULL`, else `b`. */
export function coalesce<T, K extends ScalarType>(a: Expression<T, K>, b: Operand<T, K>): Expression<T, K> {
	return new Expression("coalesce", [a, b]);
}

/** `a` where `condition` holds for the row, else `b`. */
export function when<T, K extends ScalarType>(
	condition: Condition,
	a: Operand<T, K>,
	b: Operand<T, K>,
): Expression<T, K> {
	return new Expression("when", [condition, a, b]);
}

/** One `ColumnRef` per column of `definition`, for its `(t) => …` callbacks. */
export function columnRefs(columns: readonly Column[]): { readonly [column: string]: ColumnRef } {
	return Object.fromEntries(columns.map(({ name }) => [name, new ColumnRef(name)]));
}

/** Where a condition's columns are looked up: one side of a query, or two for a joined one. */
export type Scope = {
	/** Named in errors. */
	readonly name: string;
	/** The column `ref` names here and its name in compiled nodes; `undefined` when it is of no side of this scope. */
	resolve(ref: ColumnRef): Resolved | undefined;
	/** Whether a condition here may test `exists` (a query's may, a write's may not). */
	readonly exists: boolean;
};

/** A column as a scope resolved it. */
export type Resolved = { readonly column: Column; readonly name: string };

/** The parts of a table or a column set a scope reads. */
type Side = { readonly name: string; readonly byName: ReadonlyMap<string, Column> };

/** The scope of one table: its own references, and those of the set it exposes. */
export function tableScope(table: Side & { readonly exposes?: ColumnSet | undefined }, exists: boolean): Scope {
	return {
		name: table.name,
		exists,
		resolve: (ref) => {
			if (ref.set !== undefined && ref.set !== table.exposes?.name) return undefined;
			const column = table.byName.get(ref.column);
			return column === undefined ? undefined : { column, name: column.name };
		},
	};
}

/** The scope of a column set alone: its own references (`compile`, an `exists`' inner condition). */
export function setScope(set: Side): Scope {
	return {
		name: set.name,
		exists: true,
		resolve: (ref) => {
			const column = ref.set === set.name ? set.byName.get(ref.column) : undefined;
			return column === undefined ? undefined : { column, name: column.name };
		},
	};
}

/** The name of a joined set's column in compiled nodes, orders and cursors: `<set>:<column>`. */
export function partnerName(set: string, column: string): string {
	return `${set}:${column}`;
}

/** The scope of a query of `own` joined with `set`: the partner's columns are named `<set>:<column>`. */
export function joinedScope(own: Scope, set: Side): Scope {
	return {
		name: own.name,
		exists: true,
		resolve: (ref) => {
			if (ref.set !== set.name) return own.resolve(ref);
			const column = set.byName.get(ref.column);
			return column === undefined ? undefined : { column, name: partnerName(set.name, column.name) };
		},
	};
}

/**
 * Compiles a plugin's condition over `table`'s columns for a write (a trust boundary: plugin values): known scalar
 * columns, operands of their type made storable (`invalid/args` otherwise, `undefined` included: ask with `isNull`,
 * rule 16). No `exists`.
 */
export function compileWhere(table: TableDefinition, condition: unknown, what: string): WhereNode {
	return compileCondition(tableScope(table, false), condition, what);
}

/** A condition over `set`'s columns as plain data (slice 14 §6), for `whereNode` and `existsNode`. */
export function compile(set: ColumnSet, condition: Condition): WhereNode {
	return compileCondition(setScope(set), condition, "compile");
}

/**
 * The columns of other plugins' sets a condition was written for, by set name: what `exists(Set, …)` matched and
 * compared, as the builder's `Set` declares them. A read checks them against the table bound to the set when it
 * opens (slice 14 §5: no versions, checked by name and type).
 */
export type Expected = Map<string, Map<string, Column>>;

/**
 * Compiles a plugin's condition in `scope` (a trust boundary), as `compileWhere` does for one table. The set columns
 * its `exists` use are added to `expected`.
 */
export function compileCondition(
	scope: Scope,
	condition: unknown,
	what: string,
	expected: Expected = new Map(),
): WhereNode {
	if (!(condition instanceof Condition)) throw invalid("args", `${scope.name}: ${what}: expected a condition`);
	const { op, args } = condition;
	switch (op) {
		case "and":
		case "or": {
			const nodes = args.map((each) => compileCondition(scope, each, what, expected));
			return op === "and" ? { and: nodes } : { or: nodes };
		}
		case "not":
			return { not: compileCondition(scope, args[0], what, expected) };
		case "exists":
		case "existsNode":
			return { exists: compileExists(scope, condition, what, expected) };
		case "isNull":
			return { isNull: ordered(scope, scalarColumn(scope, args[0], what), op, what).name };
		case "prefix": {
			const { column, name } = ordered(scope, scalarColumn(scope, args[0], what), op, what);
			if (column.type !== "str") throw invalid("args", `${scope.name}: ${what}: prefix needs a str() column`);
			return { prefix: [name, operand(column, args[1], what) as string] };
		}
		case "inArray": {
			const { column, name } = scalarColumn(scope, args[0], what);
			const values = args[1];
			if (!Array.isArray(values)) throw invalid("args", `${scope.name}: ${what}: inArray needs an array`);
			return { inArray: [name, values.map((value) => operand(column, value, what))] };
		}
		default: {
			const resolved = scalarColumn(scope, args[0], what);
			if (op !== "eq" && op !== "ne") ordered(scope, resolved, op, what);
			// One of the six comparisons: the node's shape is `{ [op]: [column, value] }`.
			return { [op]: [resolved.name, operand(resolved.column, args[1], what)] as const } as WhereNode;
		}
	}
}

/** How deep a condition handed over as data may nest (`and`, `or`, `not`, `exists`). */
export const NODE_DEPTH = 16;

/**
 * Compiles an `exists` of `scope`: the set's matched columns are a leading prefix of its key or of one of its
 * declared indexes, each of the type (and host kind) of the enclosing column it is matched to; the inner condition is
 * the callback's, compiled over the set, or a node, checked as `whereNode` checks one.
 */
function compileExists(scope: Scope, condition: Condition, what: string, expected: Expected): ExistsNode {
	// The builders' arguments (`exists`, `existsNode`): plugin values, read as unknown data.
	const [set, match, inner] = condition.args as [ColumnSet, { readonly [column: string]: unknown }, unknown];
	if (!scope.exists) throw invalid("args", `${scope.name}: ${what}: exists is for queries, not for writes`);
	if (typeof match !== "object" || match === null)
		throw invalid("args", `${scope.name}: ${what}: exists needs a match`);
	const pairs = Object.entries(match).map(([name, ref]) => {
		const column = set.byName.get(name);
		const outer = ref instanceof ColumnRef ? scope.resolve(ref) : undefined;
		if (column === undefined || outer === undefined) {
			throw invalid("args", `${scope.name}: ${what}: exists(${set.name}): "${name}" is matched to no column`);
		}
		checkPair(set.name, column, outer.column, `${scope.name}: ${what}`);
		return [name, outer.name] as const;
	});
	checkMatch(
		set,
		pairs.map(([name]) => name),
		`${scope.name}: ${what}`,
	);
	let node: WhereNode | null = null;
	if (condition.op === "existsNode") {
		checkNode(inner, set, `${scope.name}: ${what}: existsNode(${set.name})`);
		node = inner;
	} else if (inner !== undefined) node = compileCondition(setScope(set), inner, what, expected);
	// What this `exists` uses of the set, as its author's `Set` declares it.
	let columns = expected.get(set.name);
	if (columns === undefined) {
		columns = new Map();
		expected.set(set.name, columns);
	}
	for (const name of [...pairs.map(([each]) => each), ...(node === null ? [] : columnsOf(node))]) {
		columns.set(name, set.byName.get(name)!);
	}
	return [set.name, pairs, node];
}

/**
 * The columns a condition uses of its own side: the ones it compares, and the ones its `exists` are matched to. An
 * `exists`' inner condition is another side's.
 */
export function columnsOf(node: WhereNode): string[] {
	if ("and" in node) return node.and.flatMap(columnsOf);
	if ("or" in node) return node.or.flatMap(columnsOf);
	if ("not" in node) return columnsOf(node.not);
	if ("isNull" in node) return [node.isNull];
	if ("exists" in node) return node.exists[1].map(([, enclosing]) => enclosing);
	// The remaining nodes are `{ [op]: [column, operand] }`.
	return [(Object.values(node)[0] as readonly [string, unknown])[0]];
}

/** The `exists` a condition tests on its own side (not the ones nested inside them). */
export function existsIn(node: WhereNode): ExistsNode[] {
	if ("and" in node) return node.and.flatMap(existsIn);
	if ("or" in node) return node.or.flatMap(existsIn);
	if ("not" in node) return existsIn(node.not);
	return "exists" in node ? [node.exists] : [];
}

/** Whether `key` is the canonical stored key of an address of `host`'s kind. */
function isHostKey(host: HostColumn, key: string): boolean {
	try {
		return host.key(host.address(key), "") === key;
	} catch {
		return false;
	}
}

/** A set as a match is checked against it: its name, columns, key and declared indexes. */
export type MatchedSet = Side & {
	readonly key: readonly string[];
	readonly indexes: ReadonlyMap<string, readonly string[]>;
};

/**
 * Refuses a match that is no leading prefix of `set`'s key or of one of its declared indexes (`invalid/args`, listing
 * them): two tables are matched only by such an equality (the bounding rule, slice 14 §5).
 */
export function checkMatch(set: MatchedSet, matched: readonly string[], what: string): void {
	const paths = [set.key, ...set.indexes.values()];
	const fits = (path: readonly string[]): boolean =>
		matched.length > 0 &&
		matched.length <= path.length &&
		path.slice(0, matched.length).every((column) => matched.includes(column));
	if (paths.some(fits)) return;
	const listed = [
		`key (${set.key.join(", ")})`,
		...[...set.indexes].map(([name, columns]) => `${name} (${columns.join(", ")})`),
	];
	throw invalid(
		"args",
		`${what}: ${set.name} is matched by (${matched.join(", ")}), no leading prefix of its ${listed.join(" or ")}`,
	);
}

/** Refuses a pair of matched columns of different types or host kinds (`invalid/args`, naming the set's column). */
export function checkPair(set: string, column: Column, outer: Column, what: string): void {
	const [a, b] = [columnRecord(column), columnRecord(outer)];
	if (a.type === "json" || a.type !== b.type || a.host !== b.host) {
		throw invalid("args", `${what}: ${set} column "${column.name}" and the column it is matched to differ in type`);
	}
}

/**
 * Checks a condition handed over as data against `side`'s columns (a trust boundary, slice 14 §6): one known kind
 * per node, operand shapes and types (a `host(...)` column's operands are stored keys), every column in the side, a
 * depth bound. The inner condition of a nested `exists` is over another set: its structure is checked here, its
 * columns when the read opens and the set's table is known. `invalid/args` otherwise.
 */
export function checkNode(node: unknown, side: Side | undefined, what: string, depth = 0): asserts node is WhereNode {
	const refuse = (message: string): never => {
		throw invalid("args", `${what}: ${message}`);
	};
	if (depth > NODE_DEPTH) refuse(`nested deeper than ${NODE_DEPTH}`);
	if (typeof node !== "object" || node === null || Array.isArray(node)) refuse("a condition node is an object");
	const entries = Object.entries(node as object);
	if (entries.length !== 1) refuse("a condition node has one kind");
	const [kind, value] = entries[0] as [string, unknown];
	const column = (name: unknown): Column | undefined => {
		if (typeof name !== "string") return refuse("a column is named by a string");
		const found = side?.byName.get(name);
		if (side !== undefined && found === undefined) refuse(`no column "${name}" in ${side.name}`);
		if (found?.type === "json") refuse(`json(...) column "${name}" is not queryable`);
		return found;
	};
	const operand = (of: Column | undefined, each: unknown): void => {
		const type = typeof each;
		if (type !== "string" && type !== "boolean" && !(type === "number" && Number.isFinite(each)))
			refuse("an operand is a string, a number or a boolean");
		if (of === undefined) return;
		checkScalar(of.type as Exclude<ColumnType, "json">, each, what);
		// A `host(...)` column holds canonical address keys: anything else would silently match nothing.
		if (of.type === "str" && of.host !== undefined && !isHostKey(of.host, each as string)) {
			refuse(`"${String(each)}" is no address key of ${of.host.kind.kind} (column "${of.name}")`);
		}
	};
	/** A `host(...)` column compares only with eq, ne and inArray, as `compile` has it. */
	const ordered = (of: Column | undefined): void => {
		if (of?.type === "str" && of.host !== undefined) refuse(`${kind} on host(...) column "${of.name}"`);
	};
	const pair = (): readonly [unknown, unknown] => {
		if (!Array.isArray(value) || value.length !== 2) return refuse(`${kind} takes [column, operand]`);
		return value as unknown as readonly [unknown, unknown];
	};
	switch (kind) {
		case "and":
		case "or":
			if (!Array.isArray(value)) return refuse(`${kind} takes an array`);
			for (const each of value) checkNode(each, side, what, depth + 1);
			return;
		case "not":
			return checkNode(value, side, what, depth + 1);
		case "isNull":
			ordered(column(value));
			return;
		case "inArray": {
			const [name, values] = pair();
			const of = column(name);
			if (!Array.isArray(values)) return refuse("inArray takes an array of operands");
			for (const each of values) operand(of, each);
			return;
		}
		case "prefix": {
			const [name, text] = pair();
			const of = column(name);
			ordered(of);
			if (typeof text !== "string" || (of !== undefined && of.type !== "str"))
				refuse("prefix takes a str() column and a string");
			return;
		}
		case "eq":
		case "ne": {
			const [name, each] = pair();
			operand(column(name), each);
			return;
		}
		case "lt":
		case "lte":
		case "gt":
		case "gte": {
			const [name, each] = pair();
			const of = column(name);
			ordered(of);
			operand(of, each);
			return;
		}
		case "exists": {
			if (!Array.isArray(value) || value.length !== 3) return refuse("exists takes [set, pairs, inner]");
			const [set, pairs, inner] = value as unknown as readonly [unknown, unknown, unknown];
			if (typeof set !== "string" || !Array.isArray(pairs) || pairs.length === 0)
				return refuse("exists takes a set name and its matched pairs");
			for (const each of pairs) {
				if (!Array.isArray(each) || each.length !== 2 || typeof each[0] !== "string")
					return refuse("an exists pair is [setColumn, column]");
				column(each[1]);
			}
			if (inner !== null) checkNode(inner, undefined, what, depth + 1);
			return;
		}
		default:
			return refuse(`unknown kind "${kind}"`);
	}
}

/**
 * Compiles a plugin's `set` (plain values or a callback's result) for `table` (a trust boundary): known non-key
 * columns (rule 13), at least one (rule 14), `undefined` clearing an `opt(...)` column as the explicit `null` (a
 * `null` value is a `json(...)` cell's JSON `null`, refused for other columns), an
 * expression whose result may be `NULL` only for an `opt(...)` column; integer arithmetic only on `int` columns.
 */
export function compileSet(table: TableDefinition, set: unknown, what: string): SetNode {
	if (typeof set !== "object" || set === null || Array.isArray(set)) {
		throw invalid("args", `${table.name}: ${what}: expected an object of column values`);
	}
	const entries = Object.entries(set);
	if (entries.length === 0) throw invalid("args", `${table.name}: ${what}: the set is empty`);
	const node: { [column: string]: ExprNode } = {};
	for (const [name, value] of entries) {
		const column = table.byName.get(name);
		if (column === undefined) throw invalid("args", `${table.name}: ${what}: no column "${name}"`);
		if (table.key.includes(name)) {
			throw invalid("args", `${table.name}: ${what}: key column "${name}" cannot change (delete and put)`);
		}
		const where = `${what}: column "${name}"`;
		if (value === undefined) {
			if (!column.optional) throw invalid("args", `${table.name}: ${where} is not opt(...) and cannot be cleared`);
			node[name] = null;
		} else if (value === null && column.type !== "json") {
			// A row never holds an explicit `null` (decision "Nullable columns and the set form"); a JSON `null` is a value.
			throw invalid("args", `${table.name}: ${where}: null is no ${column.type} value (undefined clears)`);
		} else if (value instanceof Expression) {
			if (column.type === "json" || column.host !== undefined)
				throw invalid(
					"args",
					`${table.name}: ${where}: ${column.type === "json" ? "json" : "host"}(...) columns take plain values`,
				);
			const compiled = compileExpr(table, value, column.type, where);
			if (compiled.nullable && !column.optional) {
				throw invalid("args", `${table.name}: ${where}: the expression may be NULL; the column is not opt(...)`);
			}
			node[name] = compiled.node;
		} else if (column.type === "json") {
			node[name] = { json: encodeCell(column, value, `${table.name}: ${where}`).stored };
		} else node[name] = encodeCell(column, value, `${table.name}: ${where}`).stored as Scalar;
	}
	return node;
}

/** A compiled expression and whether its result may be `NULL`. */
type Compiled = { readonly node: ExprNode; readonly nullable: boolean };

function compileExpr(table: TableDefinition, value: unknown, type: ScalarType, what: string): Compiled {
	if (!(value instanceof Expression)) {
		if (value === undefined || value === null) return { node: null, nullable: true };
		return { node: checkScalar(type, value, `${table.name}: ${what}`), nullable: false };
	}
	const { op, args } = value;
	const refuse = (message: string): never => {
		throw invalid("args", `${table.name}: ${what}: ${message}`);
	};
	switch (op) {
		case "col": {
			const column = table.byName.get(args[0] as string) ?? refuse(`no column "${String(args[0])}"`);
			if (column.type !== type) refuse(`column "${column.name}" is ${column.type}, not ${type}`);
			if (column.type === "str" && column.host !== undefined)
				refuse(`host(...) column "${column.name}" holds addresses`);
			return { node: { col: column.name }, nullable: column.optional };
		}
		case "add":
		case "sub":
		case "max":
		case "min":
		case "concat": {
			const types: readonly ScalarType[] =
				op === "concat" ? ["str"] : op === "add" || op === "sub" ? ["int"] : ["int", "num"];
			if (!types.includes(type)) refuse(`${op} gives ${types.join(" or ")}, the column is ${type}`);
			const [a, b] = [compileExpr(table, args[0], type, what), compileExpr(table, args[1], type, what)];
			// The operation's shape is `{ [op]: [a, b] }`.
			return { node: { [op]: [a.node, b.node] } as ExprNode, nullable: a.nullable || b.nullable };
		}
		case "coalesce": {
			const [a, b] = [compileExpr(table, args[0], type, what), compileExpr(table, args[1], type, what)];
			return { node: { coalesce: [a.node, b.node] }, nullable: a.nullable && b.nullable };
		}
		case "replacePrefix": {
			if (type !== "str") refuse(`replacePrefix gives str, the column is ${type}`);
			const subject = compileExpr(table, args[0], type, what);
			const [from, to] = [args[1], args[2]].map(
				(each) => checkScalar("str", each, `${table.name}: ${what}`) as string,
			);
			return { node: { replacePrefix: [subject.node, from!, to!] }, nullable: subject.nullable };
		}
		case "when": {
			const condition = compileWhere(table, args[0], what);
			const [a, b] = [compileExpr(table, args[1], type, what), compileExpr(table, args[2], type, what)];
			return { node: { when: [condition, a.node, b.node] }, nullable: a.nullable || b.nullable };
		}
	}
}

/** The column a condition compares: a reference to a known scalar column of `scope`. */
function scalarColumn(scope: Scope, ref: unknown, what: string): Resolved {
	if (!(ref instanceof ColumnRef)) throw invalid("args", `${scope.name}: ${what}: expected a column reference`);
	const resolved = scope.resolve(ref);
	if (resolved === undefined) throw invalid("args", `${scope.name}: ${what}: no column "${ref.column}"`);
	if (resolved.column.type === "json")
		throw invalid("args", `${scope.name}: ${what}: json(...) column "${ref.column}" is not queryable`);
	return resolved;
}

/** `resolved` for a comparison by order, `isNull` or `prefix`: a `host(...)` column compares only with eq, ne, inArray. */
function ordered(scope: Scope, resolved: Resolved, op: string, what: string): Resolved {
	const { column } = resolved;
	if (column.type === "str" && column.host !== undefined) {
		throw invalid(
			"args",
			`${scope.name}: ${what}: ${op} on host(...) column "${column.name}" (eq, ne, inArray only)`,
		);
	}
	return resolved;
}

/**
 * An operand compared with `column`, made storable (an address as its key for a `host(...)` column); `undefined` and
 * `null` are refused (rule 16).
 */
function operand(column: Column, value: unknown, what: string): Scalar {
	if (value === undefined || value === null) {
		throw invalid("args", `${what}: column "${column.name}" compared with ${String(value)}; ask with isNull`);
	}
	// `scalarColumn` refused json columns.
	return encodeCell(column, value, `${what}: column "${column.name}"`).stored as Scalar;
}
