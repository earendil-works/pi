// `store.export(ctx)` (slice 6a §13, rule 26): the store's state after its `lastSeq` as archive parts, read page by
// page with plain reads while the export holds the commit queue (no commit can interleave, no long read transaction).
// The queue is taken at the first `next()` and given back when the iteration ends, throws, is closed or `ctx` aborts;
// an abort while the consumer is suspended gives it back at once and drops the pages and records the export held, and
// an abort while it waits for the queue ends the wait. Closing the store ends it too (`released`).

import { awaitWithContext, type Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { SqliteValue } from "../../sqlite/index.ts";
import { ChordError } from "../data/index.ts";
import { ARCHIVE_FORMAT, type ArchivePart } from "./archive.ts";
import type { TableRecord } from "./catalog.ts";
import { listRecords, listRevisions } from "./engine.ts";
import { ROW_VERSION, type Scalar, versionColumn } from "./rows.ts";
import { STORE_SCHEMA } from "./schema.ts";
import { quote, recordedPut } from "./sql.ts";
import type { ChordStore } from "./store.ts";

/** The rows and documents an export reads per page. */
export const EXPORT_PAGE = 100;

/**
 * An export of `store` under `context`: an async iterator of its parts. One pass; after an abort `next()` rejects
 * `aborted`, after the store closed `released`.
 */
export class StoreExport implements AsyncIterableIterator<ArchivePart> {
	readonly #context: Context;
	/** The parts, until the export ends; dropped then, with the pages they hold. */
	#parts: AsyncGenerator<ArchivePart> | undefined;
	#state: "open" | "aborted" | "closed" | "ended" = "open";
	/** Gives the commit queue back while the export holds it. */
	#release: (() => void) | undefined;
	readonly #abort = (): void => this.#end("aborted");

	constructor(store: ChordStore, context: Context) {
		this.#context = context;
		const hold = (release: () => void): void => this.#hold(release);
		this.#parts = parts(store, context, hold, () => this.#end("closed"));
	}

	[Symbol.asyncIterator](): this {
		return this;
	}

	async next(): Promise<IteratorResult<ArchivePart>> {
		if (this.#context.abortSignal?.aborted) this.#end("aborted");
		this.#assertOpen();
		if (this.#parts === undefined) return { done: true, value: undefined };
		const pending = this.#parts.next();
		let result: IteratorResult<ArchivePart>;
		try {
			// Until the export holds the queue only `context` ends the wait; from then on its abort listener does.
			result = await (this.#release === undefined ? awaitWithContext(pending, this.#context) : pending);
		} catch (error) {
			if (this.#context.abortSignal?.aborted) this.#end("aborted");
			this.#assertOpen();
			this.#end("ended");
			throw error;
		}
		// Ended meanwhile (an abort, the store's close): no part after that, even one that needed no read.
		this.#assertOpen();
		if (result.done) this.#end("ended");
		return result;
	}

	async return(): Promise<IteratorResult<ArchivePart>> {
		this.#end("ended");
		return { done: true, value: undefined };
	}

	/** The parts took the queue: the export holds it until it ends, and an abort ends it; ended already, it gives it back. */
	#hold(release: () => void): void {
		if (this.#state !== "open") {
			release();
			return;
		}
		this.#release = release;
		this.#context.abortSignal?.addEventListener("abort", this.#abort, { once: true });
	}

	/** Ends the export once: the queue given back, the parts closed (once they reach a `yield`) and dropped. */
	#end(state: "aborted" | "closed" | "ended"): void {
		if (this.#state !== "open") return;
		this.#state = state;
		this.#release?.();
		this.#release = undefined;
		this.#context.abortSignal?.removeEventListener("abort", this.#abort);
		void this.#parts?.return(undefined).catch(() => {});
		this.#parts = undefined;
	}

	/** Throws `aborted` after an abort, `released` after the store closed. */
	#assertOpen(): void {
		if (this.#state === "aborted") throw aborted(this.#context);
		if (this.#state === "closed")
			throw new ChordError({ code: "released", reason: "closed", message: "store: closed" });
	}
}

/** The error of a use of an aborted export: `aborted`, the signal's reason as the cause. */
function aborted(context: Context): ChordError {
	return new ChordError({ code: "aborted", message: "store: export aborted" }, { cause: context.abortSignal?.reason });
}

/**
 * The parts in archive order, after taking the queue (handed to `hold`; the store's close calls `end`); the queue is
 * given back when they end.
 */
async function* parts(
	store: ChordStore,
	context: Context,
	hold: (release: () => void) => void,
	end: () => void,
): AsyncGenerator<ArchivePart> {
	const release = await store.take(end);
	hold(release);
	try {
		if (context.abortSignal?.aborted) throw aborted(context);
		const { lastSeq, nextId } = store;
		yield { kind: "manifest", format: ARCHIVE_FORMAT, schema: STORE_SCHEMA, lastSeq, nextId };
		let writes = 0;
		const tables = [...store.tables.values()].sort((a, b) => (a.table < b.table ? -1 : 1));
		for (const record of tables) {
			const { table, version, state, columns, key, fingerprint } = record;
			yield { kind: "table", table, version, state, columns, key, fingerprint };
			writes++;
			for await (const put of puts(store, record, context)) {
				yield put;
				writes++;
			}
			for (const [name, on] of Object.entries(record.indexes)) {
				yield { kind: "index", table, name, columns: on };
				writes++;
			}
		}
		for await (const part of documents(store, context)) {
			yield part;
			writes++;
		}
		yield { kind: "end", writes };
	} finally {
		release();
	}
}

/** The `put`s of a recorded table in key order, a page per read: the stored values and their versions. */
async function* puts(
	store: ChordStore,
	record: TableRecord,
	context: Context,
): AsyncGenerator<Extract<ArchivePart, { readonly kind: "put" }>> {
	const { table, columns, key } = record;
	const select = recordedPut(table, columns)
		.physical.map((name) => quote(name))
		.join(", ");
	const order = key.map(quote).join(", ");
	let after: SqliteValue[] | undefined;
	do {
		const page = after;
		const from = page === undefined ? "" : ` WHERE (${order}) > (${page.map(() => "?").join(", ")})`;
		const sql = `SELECT ${select} FROM ${quote(table)}${from} ORDER BY ${order} LIMIT ?`;
		const rows = await store.read(
			(executor) => executor.all<{ readonly [column: string]: SqliteValue }>(sql, ...(page ?? []), EXPORT_PAGE),
			context,
		);
		for (const stored of rows) yield putOf(record, stored);
		after = rows.length < EXPORT_PAGE ? undefined : key.map((name) => rows.at(-1)![name]!);
	} while (after !== undefined);
}

/** A stored row as its `put`: `NULL` cells absent, booleans from 0 and 1, `json(...)` cells parsed with versions. */
function putOf(
	record: TableRecord,
	stored: { readonly [column: string]: SqliteValue },
): Extract<ArchivePart, { readonly kind: "put" }> {
	const row: { [column: string]: Scalar | JsonValue } = {};
	const versions: { [column: string]: number } = {};
	for (const [name, column] of Object.entries(record.columns)) {
		const value = stored[name];
		if (value === null || value === undefined) continue;
		// The recorded columns' types say what SQLite stored (STRICT tables): text for `json(...)` with its version.
		if (column.type === "bool") row[name] = value === 1;
		else if (column.type === "json") {
			row[name] = JSON.parse(value as string) as JsonValue;
			versions[name] = stored[versionColumn(name)] as number;
		} else row[name] = value as Scalar;
	}
	return { kind: "put", table: record.table, row, version: stored[ROW_VERSION] as number, columns: versions };
}

/**
 * Every stored record by id, live and retired, as its creation without a base, then its kept revisions in seq order:
 * a `none` or `latest` record's current base and its deltas, a retired `latest` one none, a `rewindable` one all.
 */
async function* documents(
	store: ChordStore,
	context: Context,
): AsyncGenerator<Extract<ArchivePart, { readonly kind: "document.create" | "document.revision" }>> {
	let after = 0;
	for (;;) {
		const records = await store.read((executor) => listRecords(executor, after, EXPORT_PAGE), context);
		for (const record of records) {
			yield { kind: "document.create", record };
			yield* revisions(store, record.id, context);
		}
		if (records.length < EXPORT_PAGE) return;
		after = records.at(-1)!.id;
	}
}

/** Document `id`'s kept revisions in seq order, read page by page (a long history is never one array). */
async function* revisions(
	store: ChordStore,
	id: number,
	context: Context,
): AsyncGenerator<Extract<ArchivePart, { readonly kind: "document.revision" }>> {
	let after = 0;
	for (;;) {
		const page = await store.read((executor) => listRevisions(executor, id, after, EXPORT_PAGE), context);
		for (const revision of page) yield { kind: "document.revision", ...revision };
		if (page.length < EXPORT_PAGE) return;
		after = page.at(-1)!.seq;
	}
}
