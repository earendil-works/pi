// The catalog (slice 6a §2, §5): the table definitions the store records (version, state, columns, key, fingerprint,
// indexes), read once at open, changed only by `table`, `index`, `dropIndex` and `alter` writes inside a step, and in
// memory again only after `COMMIT` returned.

import type { SqliteExecutor } from "../../sqlite/index.ts";
import type { ColumnRecord } from "./columns.ts";
import { TABLES } from "./schema.ts";
import type { Step } from "./step.ts";

/** A table as the store records it, by its SQL name. */
export type TableRecord = {
	readonly table: string;
	readonly version: number;
	/** `migrating` while an eager migration of `version` runs (slice 6a §9). */
	readonly state: "ready" | "migrating";
	readonly columns: { readonly [name: string]: ColumnRecord };
	readonly key: readonly string[];
	readonly fingerprint: string;
	/** Index definitions by name: their declared columns (the key is appended when rendered). */
	readonly indexes: { readonly [name: string]: readonly string[] };
};

/** Every recorded table, by SQL name. */
export async function readCatalog(executor: SqliteExecutor): Promise<Map<string, TableRecord>> {
	const rows = await executor.all<{ readonly name: string; readonly definition: string }>(
		`SELECT name, definition FROM ${TABLES.tables}`,
	);
	return new Map(rows.map(({ name, definition }) => [name, JSON.parse(definition) as TableRecord]));
}

/** Writes the table records `step` changed, once each, inside its backend transaction. */
export async function writeCatalog(step: Step): Promise<void> {
	for (const [name, record] of step.tables) {
		const definition = JSON.stringify(record);
		await step.run(`INSERT OR REPLACE INTO ${TABLES.tables} (name, definition) VALUES (?, ?)`, name, definition);
	}
}
