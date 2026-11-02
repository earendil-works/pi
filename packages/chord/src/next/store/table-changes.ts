// A transaction's writes to one table (slice 6a §6, §7; W10): checked and staged synchronously like a draft's ops (no
// I/O, a bad row throws at its own call), kept in staging order for the commit step, and overlaid on committed rows
// for `tx.get` until a bulk write makes that impossible (`invalid/read_after_bulk`).

import type { Context } from "../../context/index.ts";
import { invalid } from "../data/internal.ts";
import { applySet, type EvaluatedRow } from "./evaluate.ts";
import { compileSet, compileWhere, type SetNode } from "./expression.ts";
import type { StagedWrite } from "./step.ts";
import type { TableHandle } from "./table-handle.ts";
import {
	jsonVersions,
	recordedVersions,
	stageDelete,
	stageDeleteWhere,
	stagePut,
	stageUpdate,
	stageUpdateWhere,
} from "./table-writes.ts";

/** One staged write of one key, as the overlay replays it. */
type KeyWrite =
	| { readonly kind: "put"; readonly row: EvaluatedRow }
	| { readonly kind: "update"; readonly set: SetNode }
	| { readonly kind: "delete" };

/**
 * The writes of one transaction to one table: each appended to the transaction's staged list (`staged`, one order
 * across tables) and, for the single-key ones, to its key's overlay.
 */
export class TableChanges {
	readonly handle: TableHandle;
	readonly #staged: StagedWrite[];
	readonly #byKey = new Map<string, KeyWrite[]>();
	/** An `updateWhere` or `deleteWhere` was staged: `get` is refused from then on (W10). */
	#bulk = false;

	constructor(handle: TableHandle, staged: StagedWrite[]) {
		this.handle = handle;
		this.#staged = staged;
	}

	/** Stages a `put` of `row` (an upsert). */
	put(row: unknown): void {
		const { definition, sql } = this.handle;
		const encoded = definition.rows.put(row, definition.version);
		this.#staged.push(stagePut(sql.put, sql.table, encoded, definition.version));
		this.#write(encoded.id, { kind: "put", row: encoded.row });
	}

	/** Stages an `update` of the row with `key` (`set`: values, or a callback of column references). */
	update(key: unknown, set: unknown): void {
		const { definition, sql } = this.handle;
		const encoded = definition.rows.key(key, "update");
		const compiled = this.#set(set, "update");
		const versions = jsonVersions(this.handle.definition, compiled);
		this.#staged.push(
			stageUpdate(
				sql.update(compiled, encoded.params, versions),
				sql.table,
				encoded.key,
				compiled,
				recordedVersions(compiled, versions),
			),
		);
		this.#write(encoded.id, { kind: "update", set: compiled });
	}

	/** Stages a `delete` of the row with `key`. */
	delete(key: unknown): void {
		const { definition, sql } = this.handle;
		const encoded = definition.rows.key(key, "delete");
		this.#staged.push(stageDelete({ sql: sql.delete, params: [...encoded.params] }, sql.table, encoded.key));
		this.#write(encoded.id, { kind: "delete" });
	}

	/** Stages an `updateWhere`: every row matching `where` gets `set`. */
	updateWhere(where: unknown, set: unknown): void {
		const { definition, sql } = this.handle;
		const condition = compileWhere(
			definition,
			typeof where === "function" ? where(definition.refs) : where,
			"updateWhere",
		);
		const compiled = this.#set(set, "updateWhere");
		const versions = jsonVersions(this.handle.definition, compiled);
		const statement = sql.updateWhere(condition, compiled, versions);
		this.#staged.push(
			stageUpdateWhere(statement, sql.table, condition, compiled, recordedVersions(compiled, versions)),
		);
		this.#bulk = true;
	}

	/** Stages a `deleteWhere`: every row matching `where` goes. */
	deleteWhere(where: unknown): void {
		const { definition, sql } = this.handle;
		const condition = compileWhere(
			definition,
			typeof where === "function" ? where(definition.refs) : where,
			"deleteWhere",
		);
		this.#staged.push(stageDeleteWhere(sql.deleteWhere(condition), sql.table, condition));
		this.#bulk = true;
	}

	/**
	 * The row with `key` as this transaction leaves it: the committed row with this transaction's `put`, `update` and
	 * `delete` of the key replayed; refused after a bulk write (W10).
	 */
	async get(key: unknown, context: Context): Promise<EvaluatedRow | undefined> {
		const { definition } = this.handle;
		if (this.#bulk) {
			throw invalid(
				"read_after_bulk",
				`${definition.name}: tx.get after an updateWhere or deleteWhere on the table`,
			);
		}
		const encoded = definition.rows.key(key, "get");
		const writes = this.#byKey.get(encoded.id) ?? [];
		let start = writes.length;
		while (start > 0 && writes[start - 1]!.kind === "update") start--;
		const from = writes[start - 1];
		// A committed row is decoded by the table's columns: scalars and JSON, what the evaluator takes.
		let row: EvaluatedRow | undefined =
			from === undefined
				? ((await this.handle.get(encoded.key, context)) as EvaluatedRow | undefined)
				: from.kind === "put"
					? from.row
					: undefined;
		for (const write of writes.slice(start)) {
			// An `update` of an absent row changes nothing.
			if (row !== undefined && write.kind === "update") row = applySet(write.set, row, definition.name);
		}
		return row;
	}

	#set(set: unknown, what: string): SetNode {
		const { definition } = this.handle;
		return compileSet(definition, typeof set === "function" ? set(definition.refs) : set, what);
	}

	#write(id: string, write: KeyWrite): void {
		const writes = this.#byKey.get(id);
		if (writes === undefined) this.#byKey.set(id, [write]);
		else writes.push(write);
	}
}
