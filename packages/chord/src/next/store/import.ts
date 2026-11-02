// `importStore(backend, parts, ctx, { outbox? })` (slice 6a §13, rules 12, 24, 25): a store made from an archive, a
// trust boundary. Every part is checked against the archive schema, its place in the archive's order and its content
// (names, rows against their table's recorded columns, ids and seqs, lifetimes at one address never overlapping,
// revisions in seq order from a base, versions, duplicates, the `end` count, the manifest); everything is applied in
// one backend transaction with the applier, so a refused import leaves the backend as it was. An input that stalls is
// cancelled by `ctx`.

import { awaitWithContext, type Context } from "../../context/index.ts";
import type { SqliteDatabase, SqliteExecutor } from "../../sqlite/index.ts";
import { ChordError } from "../data/index.ts";
import { invalid } from "../data/internal.ts";
import { IdAllocator } from "./allocator.ts";
import { applyWrite } from "./applier.ts";
import { ARCHIVE_FORMAT, type ArchiveManifest, type ArchivePart, checkPart } from "./archive.ts";
import type { Backend } from "./backend.ts";
import { readCatalog, writeCatalog } from "./catalog.ts";
import type { DocumentRecord } from "./engine.ts";
import { applyStoreSchema, type MetaRow, STORE_SCHEMA, TABLES } from "./schema.ts";
import { Step } from "./step.ts";
import { ChordStore, type Store, type StoreOptions } from "./store.ts";
import { storedText } from "./text.ts";

/**
 * A store holding the archive `parts` on `backend`, which must not hold a store yet: at the manifest's `lastSeq`, its
 * outbox (when `options.outbox`) starting after it. A refused archive, a stalled input cancelled by `context` or a
 * backend error rejects; the backend is closed then (rule 12).
 */
export async function importStore(
	backend: Backend,
	parts: AsyncIterable<unknown> | Iterable<unknown>,
	context: Context,
	options: StoreOptions = {},
): Promise<Store> {
	const { db } = backend;
	try {
		context.abortSignal?.throwIfAborted();
		const existing = await db.get(`SELECT name FROM sqlite_master WHERE name = ?`, TABLES.meta);
		if (existing !== undefined) throw invalid("args", "import: the backend holds a store already");
		const meta = await db.transaction(async (executor) => {
			const meta = await applyStoreSchema(inTransaction(executor));
			const archive = new ArchiveImport(executor, context);
			await each(parts, context, (part) => archive.take(part));
			return archive.finish(meta, options.outbox === true);
		});
		return new ChordStore(db, meta, await readCatalog(db));
	} catch (error) {
		try {
			await db.close();
		} catch {
			// The import's own failure is the one to report.
		}
		throw error;
	}
}

/** The store's schema migrations run inside the import's backend transaction (they open none of their own). */
function inTransaction(executor: SqliteExecutor): SqliteDatabase {
	return {
		exec: (sql) => executor.exec(sql),
		run: (sql, ...params) => executor.run(sql, ...params),
		runCounted: (sql, ...params) => executor.runCounted(sql, ...params),
		get: (sql, ...params) => executor.get(sql, ...params),
		all: (sql, ...params) => executor.all(sql, ...params),
		transaction: (callback) => callback(executor),
		close: () => Promise.reject(new Error("import: the backend closes after the import")),
	};
}

/** A place in the archive's order: before the manifest, in a table group's puts or indexes, the documents, the end. */
type Place = "manifest" | "puts" | "indexes" | "documents" | "ended";

/**
 * One archive being imported: the place reached in its order (the manifest, then table groups of a `table` write, its
 * `put`s and its `index` writes, then the documents, then `end`), what was seen (tables, ids, live addresses, the
 * write count) and the step its writes are applied in.
 */
class ArchiveImport {
	readonly #executor: SqliteExecutor;
	readonly #context: Context;
	#position = 0;
	#manifest: ArchiveManifest | undefined;
	#step: Step | undefined;
	/** Where the next part may go. */
	#place: Place = "manifest";
	/** The table whose group is open. */
	#table: string | undefined;
	readonly #tables = new Set<string>();
	readonly #ids = new Set<number>();
	/** The lifetimes seen at each address, `[createdAt, retiredAt)` (`Infinity` while live). */
	readonly #lifetimes = new Map<string, [number, number][]>();
	/** The record whose revisions may follow, with the last revision's seq and its base's version. */
	#document: { readonly record: DocumentRecord; seq: number; base: number | undefined } | undefined;
	#writes = 0;

	constructor(executor: SqliteExecutor, context: Context) {
		this.#executor = executor;
		this.#context = context;
	}

	/** Checks the next part and applies it. */
	async take(value: unknown): Promise<void> {
		const position = this.#position++;
		const part = checkPart(value, position, this.#context);
		const what = `import: part ${position} (${part.kind})`;
		if (this.#place === "ended") throw invalid("args", `${what}: after the end`);
		if (part.kind === "manifest" || this.#step === undefined) {
			this.#start(part, what);
			return;
		}
		if (part.kind === "end") {
			if (part.writes !== this.#writes) {
				throw invalid("args", `${what}: counts ${part.writes} writes, the archive has ${this.#writes}`);
			}
			this.#endDocument(what);
			this.#place = "ended";
			return;
		}
		this.#place = this.#placeOf(part, what);
		this.#writes++;
		await applyWrite(this.#step, part, what);
	}

	/** The stored metadata once the archive ended: its `lastSeq`, the allocator's next id and the outbox setting. */
	async finish(meta: MetaRow, outbox: boolean): Promise<MetaRow> {
		if (this.#place !== "ended" || this.#step === undefined || this.#manifest === undefined) {
			throw invalid("args", "import: the archive has no end part");
		}
		const { lastSeq, nextId } = this.#manifest;
		await writeCatalog(this.#step);
		await this.#executor.run(
			`UPDATE ${TABLES.meta} SET last_seq = ?, next_id = ?, outbox = ?, outbox_floor = ? WHERE singleton = 1`,
			lastSeq,
			nextId,
			outbox ? 1 : 0,
			lastSeq,
		);
		return {
			...meta,
			last_seq: lastSeq,
			next_id: nextId,
			outbox: outbox ? 1 : 0,
			outbox_floor: lastSeq,
		};
	}

	/** The manifest, first: a format and schema this code reads. */
	#start(part: ArchivePart, what: string): void {
		if (part.kind !== "manifest" || this.#step !== undefined)
			throw invalid("args", `${what}: the manifest comes first, once`);
		if (part.format !== ARCHIVE_FORMAT)
			throw invalid("args", `${what}: format ${part.format} is not ${ARCHIVE_FORMAT}`);
		if (part.schema > STORE_SCHEMA)
			throw invalid("args", `${what}: schema ${part.schema} is newer than ${STORE_SCHEMA}`);
		this.#manifest = part;
		this.#step = new Step(this.#executor, part.lastSeq, new IdAllocator(part.nextId), new Map());
	}

	/** Where `part` puts the archive, refused when out of order, a duplicate, or outside the manifest's ranges. */
	#placeOf(part: Exclude<ArchivePart, { readonly kind: "manifest" | "end" }>, what: string): Place {
		const place = this.#place;
		switch (part.kind) {
			case "table":
				if (place === "documents") throw invalid("args", `${what}: tables come before the documents`);
				if (this.#tables.has(part.table)) throw invalid("args", `${what}: table ${part.table} occurs twice`);
				this.#tables.add(part.table);
				this.#table = part.table;
				return "puts";
			case "put":
				if (place !== "puts" || part.table !== this.#table) {
					throw invalid("args", `${what}: a put follows its table's table write, before its indexes`);
				}
				return "puts";
			case "index":
				if ((place !== "puts" && place !== "indexes") || part.table !== this.#table) {
					throw invalid("args", `${what}: an index follows its table's table write and puts`);
				}
				return "indexes";
			case "document.create":
				this.#checkDocument(part, what);
				return "documents";
			case "document.revision":
				this.#checkRevision(part, what);
				return "documents";
		}
	}

	/**
	 * A record within the manifest's ids and seqs (an id equal to a saturated `nextId` too), unique, its lifetime
	 * overlapping no other at its address; its address and meta well-formed text without NUL (SQLite would cut a NUL off,
	 * slice 6a §8). The record before it must have ended well (`#endDocument`).
	 */
	#checkDocument(part: Extract<ArchivePart, { readonly kind: "document.create" }>, what: string): void {
		this.#endDocument(what);
		const { record } = part;
		const { lastSeq, nextId } = this.#manifest!;
		const saturated = nextId === Number.MAX_SAFE_INTEGER && record.id === nextId;
		if (record.id >= nextId && !saturated) throw invalid("args", `${what}: id ${record.id} is not below ${nextId}`);
		if (this.#ids.has(record.id)) throw invalid("args", `${what}: id ${record.id} occurs twice`);
		const { createdAt, retiredAt } = record;
		if (createdAt > lastSeq || (retiredAt !== undefined && (retiredAt < createdAt || retiredAt > lastSeq))) {
			throw invalid("args", `${what}: a lifetime outside the manifest's lastSeq`);
		}
		const { namespace, owner, kind, meta } = record;
		// A singleton's record has no key; its column keeps `""`.
		const key = record.key ?? "";
		for (const text of [namespace, owner, kind, key]) {
			if (storedText(text, what) !== text) throw invalid("args", `${what}: an address is not well-formed text`);
		}
		if (meta !== undefined && storedText(meta, what) !== meta) {
			throw invalid("args", `${what}: the meta is not well-formed text`);
		}
		const address = JSON.stringify([owner, namespace, kind, key]);
		const lifetime: [number, number] = [createdAt, retiredAt ?? Number.POSITIVE_INFINITY];
		const lifetimes = this.#lifetimes.get(address) ?? [];
		// Two live records are two infinite lifetimes, which overlap; an empty one (`createdAt = retiredAt`) overlaps none.
		if (lifetime[0] < lifetime[1] && lifetimes.some(([from, to]) => from < lifetime[1] && lifetime[0] < to)) {
			throw invalid("args", `${what}: a second record at one address for an overlapping lifetime`);
		}
		lifetimes.push(lifetime);
		this.#lifetimes.set(address, lifetimes);
		this.#ids.add(record.id);
		this.#document = { record, seq: 0, base: undefined };
	}

	/**
	 * A revision of the record before it, in seq order within its lifetime, from a base, each delta at its base's
	 * version.
	 */
	#checkRevision(part: Extract<ArchivePart, { readonly kind: "document.revision" }>, what: string): void {
		const document = this.#document;
		if (document === undefined || document.record.id !== part.id) {
			throw invalid("args", `${what}: a revision follows its record's create`);
		}
		const { record } = document;
		if (record.retiredAt !== undefined && record.history !== "rewindable") {
			throw invalid("args", `${what}: a retired ${record.history} record keeps no revisions`);
		}
		if (
			part.seq <= document.seq ||
			part.seq < record.createdAt ||
			part.seq > (record.retiredAt ?? this.#manifest!.lastSeq)
		) {
			throw invalid("args", `${what}: a revision out of seq order or outside its lifetime`);
		}
		const { content } = part;
		if (content.kind === "base") document.base = content.version;
		else if (document.base !== content.version) {
			throw invalid("args", `${what}: a delta without a base at its version`);
		}
		document.seq = part.seq;
	}

	/**
	 * The record before ends well: its last base is at the record's version; only a retired `latest` record has none
	 * (its content was dropped at retirement; a retired `rewindable` one keeps its history).
	 */
	#endDocument(what: string): void {
		const document = this.#document;
		this.#document = undefined;
		if (document === undefined) return;
		const { record, base } = document;
		const contentless = record.retiredAt !== undefined && record.history === "latest";
		if (base === undefined ? !contentless : base !== record.version) {
			throw invalid("args", `${what}: record ${record.id} has no base at its version`);
		}
	}
}

/** Runs `take` on each part in turn; a wait for the next part ends when `context` aborts (the input is closed). */
async function each(
	parts: AsyncIterable<unknown> | Iterable<unknown>,
	context: Context,
	take: (part: unknown) => Promise<void>,
): Promise<void> {
	const iterator = Symbol.asyncIterator in parts ? parts[Symbol.asyncIterator]() : parts[Symbol.iterator]();
	let done = false;
	try {
		for (;;) {
			let result: IteratorResult<unknown>;
			try {
				result = await awaitWithContext(Promise.resolve(iterator.next()), context);
			} catch (error) {
				if (!context.abortSignal?.aborted) throw error;
				throw new ChordError(
					{ code: "aborted", message: "import: aborted" },
					{ cause: context.abortSignal.reason },
				);
			}
			if (result.done) {
				done = true;
				return;
			}
			await take(result.value);
		}
	} finally {
		// A stalled input is not awaited: the backend transaction ends now.
		if (!done) void Promise.resolve(iterator.return?.()).catch(() => {});
	}
}
