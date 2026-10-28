// Declared tables brought to their version at activation (slice 6a §9): a table the store does not have is created at
// the newest version with its indexes (no replay); an older one is migrated eagerly, one version at a time, in its
// commits. Per version N: (A) the edits before the data step and `table { version: N, state: "migrating" }`; the data
// step's chunks; (Z) the last chunk (or the `update`) with the edits after the step and `state: "ready"`. Without a
// data step (A) and (Z) are one commit. A version recorded `migrating` resumes after (A), skipping the rows already
// stamped `$v >= N`. Its record holds the columns during the step but version N's fingerprint, not the fingerprint of
// those columns: the fingerprint names the version being reached, which resume, export and import check.

import { type Context, withoutAbortSignal } from "../../context/index.ts";
import type { SqliteValue } from "../../sqlite/index.ts";
import type { Column } from "./columns.ts";
import type { SetNode, WhereNode } from "./expression.ts";
import { encodeCell, ROW_VERSION, type Scalar } from "./rows.ts";
import { type Order, TableSql } from "./sql.ts";
import type { StagedWrite } from "./step.ts";
import type { ChordStore, CommitFence } from "./store.ts";
import type { TableDefinition } from "./table.ts";
import { type DataStep, planTable, type TablePlan } from "./table-history.ts";
import {
	jsonVersions,
	recordedVersions,
	stageEdit,
	stageIndex,
	stageTable,
	stageUpdate,
	stageUpdateWhere,
} from "./table-writes.ts";

/** A declared table: its newest definition and its SQL name. */
export type DeclaredTable = { readonly definition: TableDefinition; readonly table: string };

/** Where a migration runs: the store, the table's SQL name and the commits' fence. */
type MigrationTarget = { readonly store: ChordStore; readonly table: string; readonly fence: CommitFence };

/**
 * Brings `tables` to their definitions: the ones the store does not have created in one commit, then each older one
 * migrated. A table the code cannot use (see `planTable`) throws before anything is written; `what` names the owner.
 */
export async function prepareTables(
	tables: readonly DeclaredTable[],
	store: ChordStore,
	fence: CommitFence,
	what: string,
	context: Context,
): Promise<void> {
	const created: StagedWrite[] = [];
	const migrations: { readonly table: string; readonly plan: Extract<TablePlan, { readonly kind: "migrate" }> }[] = [];
	for (const { definition, table } of tables) {
		const plan = planTable(definition, store.table(table), `${what}: table "${definition.name}"`);
		if (plan.kind === "create") created.push(...creation(definition, table));
		else if (plan.kind === "migrate") migrations.push({ table, plan });
	}
	if (created.length > 0) await commit(created, { store, fence }, context);
	for (const { table, plan } of migrations) {
		await migrateTable(plan, { store, table, fence }, context);
	}
}

/** The writes creating `definition` fresh as `table`: at its version, `ready`, with its indexes. */
function creation(definition: TableDefinition, table: string): StagedWrite[] {
	const { version, record: columns, key, fingerprint } = definition;
	return [
		stageTable({ kind: "table", table, version, state: "ready", columns, key, fingerprint }),
		...[...definition.indexes].map(([name, columns]) => stageIndex({ kind: "index", table, name, columns })),
	];
}

/**
 * Migrates the table through the plan's versions (oldest first, each with its migration), the first resumed after its
 * (A) commit when the plan says so. `context`'s abort is checked between chunks (a chunk admitted to the step completes); a data
 * step that throws, or returns a patch the version cannot take, rejects: the table stays `migrating` and the committed
 * chunks stay.
 */
async function migrateTable(
	plan: Extract<TablePlan, { readonly kind: "migrate" }>,
	target: MigrationTarget,
	context: Context,
): Promise<void> {
	for (const [index, version] of plan.versions.entries()) {
		await migrateVersion(version, index === 0 ? plan.first : "begin", target, context);
	}
}

/** The size of a `rows` chunk: one commit each. */
export const MIGRATION_CHUNK = 100;

/** Migrates to `definition`'s version from its (A) commit (`begin`) or after it (`resume`). */
async function migrateVersion(
	definition: TableDefinition,
	from: "begin" | "resume",
	target: MigrationTarget,
	context: Context,
): Promise<void> {
	const { before, step, after } = definition.evolution!.migration;
	const { table } = target;
	const edits = (list: typeof before): StagedWrite[] => list.map((edit) => stageEdit(table, definition.version, edit));
	const ready = [...edits(after), recordOf(definition, definition, "ready", table)];
	if (step === undefined) return commit([...edits(before), ...ready], target, context);
	if (from === "begin")
		await commit([...edits(before), recordOf(step.table, definition, "migrating", table)], target, context);
	if (step.kind === "update") return commit([updateStep(step, definition.version, table), ...ready], target, context);
	await rowsStep(step, definition.version, ready, target, context);
}

/** The `table` write of `table`'s columns and key, with `definition`'s version and fingerprint, in `state`. */
function recordOf(
	columns: TableDefinition,
	definition: TableDefinition,
	state: "ready" | "migrating",
	table: string,
): StagedWrite {
	const { version, fingerprint } = definition;
	return stageTable({ kind: "table", table, version, state, columns: columns.record, key: columns.key, fingerprint });
}

/** The `update` step: one `updateWhere` over the rows below version `v`, stamping it, so it never applies twice. */
function updateStep(step: Extract<DataStep, { readonly kind: "update" }>, v: number, table: string): StagedWrite {
	const sql = sqlOf(step.table, table);
	const below: WhereNode = { lt: [ROW_VERSION, v] };
	const where: WhereNode = step.where === undefined ? below : { and: [step.where, below] };
	const versions = jsonVersions(step.table, step.set);
	const statement = sql.updateWhere(where, { ...step.set, [ROW_VERSION]: v }, versions);
	return stageUpdateWhere(statement, table, where, step.set, recordedVersions(step.set, versions), v);
}

/**
 * The `rows` step: chunks of `MIGRATION_CHUNK` rows below version `v` in key order, paging forward by the last key;
 * each patched row stamped `v`; the last chunk commits with `ready`.
 */
async function rowsStep(
	step: Extract<DataStep, { readonly kind: "rows" }>,
	v: number,
	ready: readonly StagedWrite[],
	target: MigrationTarget,
	context: Context,
): Promise<void> {
	const { table: columns } = step;
	const sql = sqlOf(columns, target.table);
	const order: Order = { columns: columns.key, direction: "asc" };
	const below: WhereNode = { lt: [ROW_VERSION, v] };
	let after: SqliteValue[] | undefined;
	// The fallback yield between chunks (`macrotask`), made by the first yield that needs it, closed at the end.
	let channel: InstanceType<typeof MessageChannel> | undefined;
	try {
		for (;;) {
			const statement = sql.select(below, order, after, MIGRATION_CHUNK + 1);
			const stored = await target.store.read(
				(executor) => executor.all<{ [column: string]: SqliteValue }>(statement.sql, ...statement.params),
				context,
			);
			const last = stored.length <= MIGRATION_CHUNK;
			if (!last) stored.length = MIGRATION_CHUNK;
			const writes = stored.map((row) => patchRow(step, row, v, sql, target.table, context));
			if (last) return await commit([...writes, ...ready], target, context);
			await commit(writes, target, context);
			after = columns.key.map((name) => stored[MIGRATION_CHUNK - 1]![name]!);
			await macrotask(() => {
				channel ??= new MessageChannel();
				return channel;
			});
			// An abandoned activation stops here.
			context.abortSignal?.throwIfAborted();
		}
	} finally {
		channel?.port1.close();
	}
}

/**
 * Resolves after one macrotask (other commits and timers run between chunks) without the 1 ms clamp of
 * `setTimeout(0)`: `setImmediate` where the runtime has it (Node), else a message through the channel `channel()`
 * gives (browsers, Workers). In Node a message costs 0.27 ms per yield against `setImmediate`'s 13 µs (the 10k-row
 * migration bench: 100 ms against 70 ms).
 */
function macrotask(channel: () => InstanceType<typeof MessageChannel>): Promise<void> {
	return new Promise((resolve) => {
		// A runtime feature check: Workers and browsers have no `setImmediate`.
		if ("setImmediate" in globalThis) {
			setImmediate(resolve);
			return;
		}
		const { port1, port2 } = channel();
		port1.addEventListener("message", () => resolve(), { once: true });
		// A port listened to with `addEventListener` delivers only once started (browsers, Workers).
		port1.start();
		port2.postMessage(null);
	});
}

/**
 * The write of one row's patch: `patch` run on the decoded row, its result checked (an object of non-key columns of
 * the version, values of their types) and stamped `v` through the internal form of `update`.
 */
function patchRow(
	step: Extract<DataStep, { readonly kind: "rows" }>,
	stored: { readonly [column: string]: SqliteValue },
	v: number,
	sql: TableSql,
	table: string,
	context: Context,
): StagedWrite {
	const { table: definition } = step;
	const patch = step.patch(definition.rows.decode(stored, context));
	const what = `${definition.name} version ${v}: rows`;
	if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
		throw new Error(`${what}: expected an object of column values`);
	}
	const set: { [column: string]: SetNode[string] } = {};
	for (const [name, value] of Object.entries(patch)) {
		const column = definition.byName.get(name);
		if (column === undefined) throw new Error(`${what}: no column "${name}"`);
		if (definition.key.includes(name)) throw new Error(`${what}: key column "${name}" cannot change`);
		set[name] = cellOf(column, value, `${what}: column "${name}"`);
	}
	const key: { [column: string]: Scalar } = {};
	// Key columns are non-opt `str` or `int`: stored scalars.
	for (const name of definition.key) key[name] = stored[name] as Scalar;
	const versions = jsonVersions(definition, set);
	const params = definition.key.map((name) => stored[name]!);
	const statement = sql.update({ ...set, [ROW_VERSION]: v }, params, versions);
	return stageUpdate(statement, table, key, set, recordedVersions(set, versions), v);
}

/**
 * A patch value as a `set` node: `undefined` clears an `opt(...)` column, `json(...)` cells as JSON literals (a JSON
 * `null` too); a scalar `null` is refused by `encodeCell`.
 */
function cellOf(column: Column, value: unknown, what: string): SetNode[string] {
	if (value === undefined) {
		if (!column.optional) throw new Error(`${what} is not opt(...) and cannot be cleared`);
		return null;
	}
	const cell = encodeCell(column, value, what);
	// `encodeCell` returns a scalar for a scalar column.
	return column.type === "json" ? { json: cell.stored } : (cell.stored as Scalar);
}

function sqlOf(definition: TableDefinition, table: string): TableSql {
	return new TableSql(table, definition.columns, definition.rows.physical, definition.key);
}

/** Commits `writes` without the activation's abort: a commit admitted to the step completes (the fence refuses one). */
async function commit(writes: StagedWrite[], target: Omit<MigrationTarget, "table">, context: Context): Promise<void> {
	await target.store.commit(writes, target.fence, withoutAbortSignal(context));
}
