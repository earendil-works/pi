// The JavaScript evaluator of the compiled table vocabulary (slice 6a §6; rule 10): the `tx.get` overlay matches
// `where` nodes and applies `set` nodes with SQL's three-valued `NULL` rules and code point text order, as the SQL
// that `sql.ts` renders from the same nodes does in SQLite.

import type { JsonValue } from "../../json.ts";
import { invalid } from "../data/internal.ts";
import type { Comparison, ExprNode, Operation, SetNode, WhereNode } from "./expression.ts";
import type { Scalar } from "./rows.ts";
import { compareText } from "./text.ts";

/** A row as the evaluator reads it: stored cells, an absent column being `NULL`. */
export type EvaluatedRow = { readonly [column: string]: Scalar | JsonValue | undefined };

/** SQL's three-valued truth: `null` is unknown (a comparison with `NULL`). */
type Truth = boolean | null;

/** Whether `row` matches `node` under SQL's rules: unknown (`NULL`) does not match. */
export function matches(node: WhereNode, row: EvaluatedRow): boolean {
	return truth(node, row) === true;
}

function truth(node: WhereNode, row: EvaluatedRow): Truth {
	if ("and" in node)
		return node.and.reduce<Truth>((all, each) => (all === false ? false : both(all, truth(each, row))), true);
	if ("or" in node)
		return node.or.reduce<Truth>((any, each) => (any === true ? true : either(any, truth(each, row))), false);
	if ("not" in node) {
		const inner = truth(node.not, row);
		return inner === null ? null : !inner;
	}
	if ("isNull" in node) return row[node.isNull] === undefined;
	// The row is checked against the table the condition was compiled for: its columns hold scalars.
	if ("inArray" in node) {
		const [column, values] = node.inArray;
		// SQL: `x IN ()` is false, for a `NULL` x too.
		if (values.length === 0) return false;
		const value = row[column] as Scalar | undefined;
		return value === undefined ? null : values.some((each) => compareScalar(value, each) === 0);
	}
	if ("prefix" in node) {
		const value = row[node.prefix[0]] as string | undefined;
		return value === undefined ? null : value.startsWith(node.prefix[1]);
	}
	// The remaining nodes are the comparisons, one entry each; `Object.entries` loses that.
	const [op, [column, operand]] = Object.entries(node)[0] as [Comparison, readonly [string, Scalar]];
	const value = row[column] as Scalar | undefined;
	if (value === undefined) return null;
	const order = compareScalar(value, operand);
	switch (op) {
		case "eq":
			return order === 0;
		case "ne":
			return order !== 0;
		case "lt":
			return order < 0;
		case "lte":
			return order <= 0;
		case "gt":
			return order > 0;
		case "gte":
			return order >= 0;
	}
}

function both(a: Truth, b: Truth): Truth {
	if (a === false || b === false) return false;
	return a === null || b === null ? null : true;
}

function either(a: Truth, b: Truth): Truth {
	if (a === true || b === true) return true;
	return a === null || b === null ? null : false;
}

/** Orders two cells of one column as SQLite does: text by code point, booleans as 0 and 1, numbers numerically. */
export function compareScalar(a: Scalar, b: Scalar): number {
	if (typeof a === "string") return compareText(a, b as string);
	return Number(a) - Number(b);
}

const SAFE = Number.MAX_SAFE_INTEGER;

/**
 * `row` after `set`, every right side evaluated against `row` (simultaneous: `{ a: b, b: a }` swaps); an integer
 * result outside ±(2^53 - 1) throws `invalid/args` (rule 10), as the column's `CHECK` fails the step.
 */
export function applySet(set: SetNode, row: EvaluatedRow, table: string): EvaluatedRow {
	const next: { [column: string]: Scalar | JsonValue | undefined } = { ...row };
	for (const [column, node] of Object.entries(set)) {
		const value = evaluate(node, row, table);
		if (value === undefined) delete next[column];
		else next[column] = value;
	}
	return next;
}

function evaluate(node: ExprNode, row: EvaluatedRow, table: string): Scalar | JsonValue | undefined {
	if (node === null) return undefined;
	if (typeof node !== "object") return node;
	if ("col" in node) return row[node.col];
	if ("json" in node) return node.json;
	if ("when" in node) {
		const [condition, a, b] = node.when;
		return evaluate(matches(condition, row) ? a : b, row, table);
	}
	if ("coalesce" in node) return evaluate(node.coalesce[0], row, table) ?? evaluate(node.coalesce[1], row, table);
	if ("replacePrefix" in node) {
		const [subject, from, to] = node.replacePrefix;
		const value = evaluate(subject, row, table) as string | undefined;
		return value === undefined || !value.startsWith(from) ? value : to + value.slice(from.length);
	}
	// The remaining nodes are the arithmetic and text operations, one entry each, over scalar operands (compiled so).
	const [op, [x, y]] = Object.entries(node)[0] as [Operation, readonly [ExprNode, ExprNode]];
	const a = evaluate(x, row, table) as Scalar | undefined;
	const b = evaluate(y, row, table) as Scalar | undefined;
	if (a === undefined || b === undefined) return undefined;
	switch (op) {
		case "concat":
			return (a as string) + (b as string);
		case "max":
			return compareScalar(a, b) >= 0 ? a : b;
		case "min":
			return compareScalar(a, b) <= 0 ? a : b;
		default: {
			const result = op === "add" ? (a as number) + (b as number) : (a as number) - (b as number);
			if (result > SAFE || result < -SAFE)
				throw invalid("args", `${table}: ${op} gives ${result}, outside ±(2^53 - 1)`);
			return result;
		}
	}
}
