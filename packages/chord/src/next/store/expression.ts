// The table expression language (slice 6a §6, §7; rules 10, 13, 14, 16; decision "Nullable columns and the `set`
// form"): the builders plugins write `where` and `set` with, and their compilation at staging into one data-only
// vocabulary (what the outbox and archives carry; `evaluate.ts` runs it in JavaScript, `sql.ts` renders it).

import type { TOptional } from "typebox";
import type { JsonValue } from "../../json.ts";
import type { TSchema } from "../contracts/index.ts";
import { invalid } from "../data/internal.ts";
import type { Column, Columns, ColumnType, ColumnTypeOf, ValueOf } from "./columns.ts";
import { checkScalar, encodeCell, type Scalar } from "./rows.ts";
import type { TableDefinition } from "./table.ts";

/** A compiled condition: column comparisons with checked operands, combined by `and`, `or`, `not`. */
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
	| { readonly not: WhereNode };

/** A compiled value expression: a literal (`null` clears), a column, a `json(...)` cell, or an operation. */
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

/** A reference to a column of the row, as `(t) => …` callbacks get them. */
export class ColumnRef<T = unknown, K extends ColumnType = ColumnType> extends Expression<T, K> {
	readonly column: string;

	constructor(column: string) {
		super("col", [column]);
		this.column = column;
	}
}

/** A condition as a plugin builds it; compiled when staged or run. */
export class Condition {
	readonly op: Comparison | "inArray" | "isNull" | "prefix" | "and" | "or" | "not";
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
	readonly [P in Exclude<keyof C & string, K[number]>]?: C[P] extends TOptional<TSchema>
		? ValueOf<C[P]> | Expression<ValueOf<C[P]>, ColumnTypeOf<C[P]>> | undefined
		: ValueOf<C[P]> | Expression<ValueOf<C[P]>, ColumnTypeOf<C[P]>>;
};

/** A scalar column type. */
type ScalarType = Exclude<ColumnType, "json">;

/** An operand of type `T` and column type `K`: an expression or a plain value. */
type Operand<T, K extends ColumnType> = Expression<T, K> | T;

/** The column equals `value` (`NULL` never matches). */
export function eq<T extends Scalar>(column: ColumnRef<T, ScalarType>, value: T): Condition {
	return new Condition("eq", [column, value]);
}

/** The column differs from `value` (`NULL` never matches). */
export function ne<T extends Scalar>(column: ColumnRef<T, ScalarType>, value: T): Condition {
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
export function inArray<T extends Scalar>(column: ColumnRef<T, ScalarType>, values: readonly T[]): Condition {
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

/**
 * Compiles a plugin's condition over `table`'s columns (a trust boundary: plugin values): known scalar columns,
 * operands of their type made storable (`invalid/args` otherwise, `undefined` included: ask with `isNull`, rule 16).
 */
export function compileWhere(table: TableDefinition, condition: unknown, what: string): WhereNode {
	if (!(condition instanceof Condition)) throw invalid("args", `${table.name}: ${what}: expected a condition`);
	const { op, args } = condition;
	switch (op) {
		case "and":
		case "or": {
			const nodes = args.map((each) => compileWhere(table, each, what));
			return op === "and" ? { and: nodes } : { or: nodes };
		}
		case "not":
			return { not: compileWhere(table, args[0], what) };
		case "isNull":
			return { isNull: scalarColumn(table, args[0], what).name };
		case "prefix": {
			const column = scalarColumn(table, args[0], what);
			if (column.type !== "str") throw invalid("args", `${table.name}: ${what}: prefix needs a str() column`);
			return { prefix: [column.name, operand(column, args[1], what) as string] };
		}
		case "inArray": {
			const column = scalarColumn(table, args[0], what);
			const values = args[1];
			if (!Array.isArray(values)) throw invalid("args", `${table.name}: ${what}: inArray needs an array`);
			return { inArray: [column.name, values.map((value) => operand(column, value, what))] };
		}
		default: {
			const column = scalarColumn(table, args[0], what);
			// One of the six comparisons: the node's shape is `{ [op]: [column, value] }`.
			return { [op]: [column.name, operand(column, args[1], what)] as const } as WhereNode;
		}
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
			if (column.type === "json")
				throw invalid("args", `${table.name}: ${where}: json(...) columns take plain values`);
			const compiled = compileExpr(table, value, column.type, where);
			if (compiled.nullable && !column.optional) {
				throw invalid("args", `${table.name}: ${where}: the expression may be NULL; the column is not opt(...)`);
			}
			node[name] = compiled.node;
		} else if (column.type === "json") {
			node[name] = { json: encodeCell(column, value, `${table.name}: ${where}`).stored };
		} else node[name] = checkScalar(column.type, value, `${table.name}: ${where}`);
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

/** The column a condition compares: a reference to a known scalar column. */
function scalarColumn(table: TableDefinition, ref: unknown, what: string): Column {
	if (!(ref instanceof ColumnRef)) throw invalid("args", `${table.name}: ${what}: expected a column reference`);
	const column = table.byName.get(ref.column);
	if (column === undefined) throw invalid("args", `${table.name}: ${what}: no column "${ref.column}"`);
	if (column.type === "json")
		throw invalid("args", `${table.name}: ${what}: json(...) column "${ref.column}" is not queryable`);
	return column;
}

/** An operand compared with `column`, made storable; `undefined` and `null` are refused (rule 16). */
function operand(column: Column, value: unknown, what: string): Scalar {
	if (value === undefined || value === null) {
		throw invalid("args", `${what}: column "${column.name}" compared with ${String(value)}; ask with isNull`);
	}
	// `scalarColumn` refused json columns.
	return checkScalar(column.type as ScalarType, value, `${what}: column "${column.name}"`);
}
