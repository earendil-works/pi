// The skip test (slice 14 §3.3): whether a commit's writes can have changed a read's result. A skip proves the
// result unchanged by the row before the write (the keys and matched values the read kept of its last run) and by
// the row after it (the probe: the read's own statement, limited to the rows the written row pairs with). There is no
// second evaluator: the database decides with the real condition.

import type { Context } from "../context/index.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import { chordMetrics } from "../telemetry.ts";
import { identityOf, type Read, type ReadResult } from "./read.ts";
import type { Use } from "./read-plan.ts";
import type { Step } from "./step.ts";

/**
 * One write of a transaction as the skip test reads it. A single-key write names its key and, for an `update`, the
 * columns it assigns; a bulk one the columns it assigns (`undefined`: it deletes rows).
 */
export type Change =
	| {
			readonly table: string;
			readonly kind: "put" | "update" | "delete";
			readonly key: { readonly [column: string]: SqliteValue };
			readonly assigned: readonly string[] | undefined;
	  }
	| { readonly table: string; readonly kind: "bulk"; readonly assigned: readonly string[] | undefined };

/**
 * How many probes one read may ask in one step before it runs instead. A probe costs a few microseconds and a run
 * of a page a few hundred (`benchmarks.md`), so a transaction writing many rows (an import, a bulk `put`) must not
 * probe a read once per row: past this many, running it is cheaper than asking on.
 */
const PROBES_PER_READ = 8;

/**
 * Whether `changes` (the writes of one step, already applied) leave `read`'s result as it is: every change is
 * skipped for every use of its table by the read. A read without a result (loading, failed) is never skipped.
 */
export async function skips(read: Read, changes: readonly Change[], step: Step, context: Context): Promise<boolean> {
	const latest = read.latest(step.executor);
	if (latest === undefined || latest.kind === "failed") return false;
	const result = latest.kind === "rows" ? latest.result : undefined;
	const budget = { probes: PROBES_PER_READ };
	for (const change of changes) {
		for (const use of read.plan.uses) {
			if (use.table !== change.table) continue;
			if (!(await skipped(read, use, change, result, step, context, budget))) return false;
		}
	}
	return true;
}

/** One change against one use of its table (the table of slice 14 §3.3, row by row). */
async function skipped(
	read: Read,
	use: Use,
	change: Change,
	result: ReadResult | undefined,
	step: Step,
	context: Context,
	budget: { probes: number },
): Promise<boolean> {
	const assigns = (columns: ReadonlySet<string>): boolean =>
		change.assigned === undefined || change.assigned.some((name) => columns.has(name));
	// "Any": an `update` (a bulk one too) that assigns none of the columns the read depends on in that table.
	if (change.kind !== "put" && change.kind !== "delete" && !assigns(use.depends)) return true;
	// A bulk write names no rows, and a count keeps none: nothing more can be proved.
	if (change.kind === "bulk" || result === undefined) return false;
	// Where the value before is unknown and matters, the read runs: a matched column outside the key may have been
	// re-pointed, and the rows it paired with before are unknown.
	if (!use.stable) return false;
	const values = use.pairedBy.map((name) => change.key[name]!);
	const fetched = use.role === "own" ? result.keys : result.paired.get(use);
	// Before: a fetched row the written row pairs with decided the result (unknown pairs count as one).
	if (fetched === undefined || fetched.has(identityOf(values))) return false;
	// After. A row that was not in the result cannot enter it by leaving (its own delete, its partner's), nor by an
	// `update` of columns that decide neither membership nor position. An `exists` row's delete or update can bring
	// its own rows in (`not(exists(…))`): only the probe tells.
	if (use.role !== "exists" && (change.kind === "delete" || (change.kind === "update" && !assigns(use.enters))))
		return true;
	if (!use.keyed || budget.probes-- === 0) return false;
	return !(await probe(read, use.pairs!, values, result, step, context));
}

/** The probe: whether, after the step's writes, a row with `values` in `columns` is in the read's range. */
async function probe(
	read: Read,
	columns: readonly string[],
	values: readonly SqliteValue[],
	result: ReadResult,
	step: Step,
	context: Context,
): Promise<boolean> {
	chordMetrics(context.telemetry.metrics).counter("chord.query.probes").add(1);
	const { sql, params } = read.plan.probe(read.probed(result), columns, values);
	return (await step.get<{ readonly found: number }>(sql, ...params)) !== undefined;
}
