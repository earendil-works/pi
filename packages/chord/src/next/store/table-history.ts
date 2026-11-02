// A table's history (slice 6a §9; decision "Second spec review: the majority"): the versions from a base
// `defineTable` through each `evolveTable`, the migration each version recorded, and what an activation does with the
// version the store recorded: create the table, use it, migrate it from there, or refuse it.

import type { TableRecord } from "./catalog.ts";
import type { ColumnRecord } from "./columns.ts";
import type { SetNode, WhereNode } from "./expression.ts";
import type { TableDefinition } from "./table.ts";

/** One edit of a migration as its writes record it (`alter`, `index`, `dropIndex`); the table is named when applied. */
export type TableEdit =
	| { readonly kind: "rename"; readonly from: string; readonly to: string }
	| { readonly kind: "add"; readonly name: string; readonly column: ColumnRecord }
	| { readonly kind: "drop"; readonly name: string }
	| { readonly kind: "json"; readonly name: string; readonly column: ColumnRecord }
	| { readonly kind: "index"; readonly name: string; readonly columns: readonly string[] }
	| { readonly kind: "dropIndex"; readonly name: string };

/** The column edits an `alter` write records. */
export type AlterEdit = Extract<TableEdit, { readonly kind: "rename" | "add" | "drop" | "json" }>;

/**
 * A version's data step over `table`, the columns between the edits before it and after it: `rows` patches each row
 * (synchronous and pure), `update` is one `updateWhere`.
 */
export type DataStep =
	| {
			readonly kind: "rows";
			readonly table: TableDefinition;
			readonly patch: (row: { readonly [column: string]: unknown }) => unknown;
	  }
	| {
			readonly kind: "update";
			readonly table: TableDefinition;
			readonly where: WhereNode | undefined;
			readonly set: SetNode;
	  };

/** What one `evolveTable` changed: the edits before the data step, the step, the edits after it. */
export type Migration = {
	readonly before: readonly TableEdit[];
	readonly step: DataStep | undefined;
	readonly after: readonly TableEdit[];
};

/**
 * What an activation does with a declared table: create it at the newest version, use it as recorded, or migrate it
 * through `versions` (oldest first), the first one from its start (`begin`) or, recorded `migrating`, after its (A)
 * commit (`resume`).
 */
export type TablePlan =
	| { readonly kind: "create" }
	| { readonly kind: "ready" }
	| {
			readonly kind: "migrate";
			readonly versions: readonly TableDefinition[];
			readonly first: "begin" | "resume";
	  };

/**
 * The plan for `definition` (the code's newest version) against `recorded`. A recorded version newer than the newest,
 * older than the history's base, or the same version with another fingerprint (a history edited in place) throws:
 * the object fails `broken`, the data stays.
 */
export function planTable(definition: TableDefinition, recorded: TableRecord | undefined, what: string): TablePlan {
	if (recorded === undefined) return { kind: "create" };
	const { version, state, fingerprint } = recorded;
	if (version > definition.version) {
		throw new Error(`${what}: the store has version ${version}, newer than the code's ${definition.version}`);
	}
	const versions = historyOf(definition);
	const at = versions.find((each) => each.version === version);
	if (at === undefined) {
		throw new Error(
			`${what}: the store has version ${version}, older than the history's base ${versions[0]!.version}`,
		);
	}
	if (at.fingerprint !== fingerprint) {
		throw new Error(`${what}: version ${version} is recorded with another definition (a history edited in place)`);
	}
	if (state === "ready" && version === definition.version) return { kind: "ready" };
	if (state === "migrating" && at.evolution?.migration.step === undefined) {
		throw new Error(`${what}: version ${version} is recorded migrating, but has no data step to resume`);
	}
	if (state === "migrating") {
		return { kind: "migrate", versions: versions.filter((each) => each.version >= version), first: "resume" };
	}
	return { kind: "migrate", versions: versions.filter((each) => each.version > version), first: "begin" };
}

/** Every version of `definition`'s history, the base first. */
function historyOf(definition: TableDefinition): TableDefinition[] {
	const versions: TableDefinition[] = [];
	for (let at: TableDefinition | undefined = definition; at !== undefined; at = at.evolution?.previous) {
		versions.unshift(at);
	}
	return versions;
}
