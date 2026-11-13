// The data belonging to one host address (decision "Documents and table rows can belong to a host"; spec
// `docs/host-keyed/spec.md` §4): the records whose `host` is the address's key and the rows holding it in a `host(...)`
// column, exported as an archive in the store's format, imported into a store that may hold data (refused, replaced
// or copied under another address of the kind, older tables' rows migrated, in one commit) and deleted in one commit.
// Imports are a trust boundary. Export and read are public; import and delete are the host's (`host/host-data.ts`
// coordinates the live owners around them).

import type { Context } from "../context/index.ts";
import type { Address } from "../contracts/index.ts";
import { kindOfKey } from "../contracts/internal.ts";
import { invalid } from "../data/internal.ts";
import { apply, type Op } from "../delta/index.ts";
import type { JsonValue } from "../json.ts";
import type { SqliteValue } from "../sqlite/index.ts";
import { applyWrite } from "./applier.ts";
import { ARCHIVE_FORMAT, type ArchivePart, checkPart } from "./archive.ts";
import { createDocument, type DocumentRecord, listHostRecords, retireDocument } from "./engine.ts";
import { hostColumn, StoreExport } from "./export.ts";
import { each } from "./import.ts";
import { migrateRows } from "./import-migration.ts";
import { checkScalar, toSqlite } from "./rows.ts";
import { STORE_SCHEMA, TABLES } from "./schema.ts";
import { quote } from "./sql.ts";
import type { StagedWrite, Step } from "./step.ts";
import type { ChordStore, CommitFence, Store } from "./store.ts";
import type { TableDefinition } from "./table.ts";
import type { TableWrite } from "./table-writes.ts";
import { storedText } from "./text.ts";
import type { StoreWrite } from "./writes.ts";

/** What the host's `importHostData` takes besides the kind, the archive and the context. */
export type HostImportOptions = {
	/** The address the data is imported under: a copy when it is not the archive's; another kind is refused. */
	readonly address?: Address;
	/** What happens when the store has data of the address: refused (the default), or replaced in the same commit. */
	readonly existing?: "refuse" | "replace";
};

/** What an import or a delete changed: the documents it created or retired, the rows it put or deleted. */
export type HostDataCounts = { readonly documents: number; readonly rows: number };

/** A host's data archive, read and checked (`readHostArchive`): one archive is one commit, so it is held in memory. */
export type HostArchive = {
	/** The address key whose data it holds (its manifest's `host`). */
	readonly host: string;
	readonly tables: readonly HostTable[];
	readonly documents: readonly HostDocument[];
};

/** One table of a host's data archive: its `table` write, its host column, the `put`s of the host's rows, its indexes. */
export type HostTable = {
	readonly write: Extract<TableWrite, { readonly kind: "table" }>;
	readonly column: string;
	readonly puts: Extract<TableWrite, { readonly kind: "put" }>[];
	readonly indexes: Extract<TableWrite, { readonly kind: "index" }>[];
};

/** One document of a host's data archive: its record and its value (its base with its deltas applied). */
type HostDocument = { readonly record: DocumentRecord; readonly value: JsonValue };

/**
 * The records and rows of `store` belonging to `address` as archive parts (manifest with `host`, the tables with a
 * `host(...)` column of its kind and only its rows, its records), holding the commit queue as `store.export` does.
 */
export function exportHostData(store: Store, address: Address, context: Context): AsyncIterableIterator<ArchivePart> {
	// Stores are Chord's own: `openStore` and `importStore` made them.
	const chord = store as ChordStore;
	chord.assertUsable();
	return new StoreExport(chord, context, { kind: "host", key: storedText(address.key, "exportHostData: address") });
}

/**
 * Reads and checks a host's data archive (a trust boundary): every part by the archive schema and in archive order;
 * a manifest with `host` (well-formed text); tables with exactly one host column of that address's kind; every row's host cell and every
 * record's `host` and key the manifest's `host`; live Chord records (history `none`) whose revisions start at a base,
 * each delta at its base's version; `end` counting the parts between. `invalid/args` otherwise.
 */
export async function readHostArchive(
	parts: AsyncIterable<unknown> | Iterable<unknown>,
	context: Context,
): Promise<HostArchive> {
	const reader = new HostArchiveReader(context);
	await each(parts, context, async (part) => reader.take(part));
	return reader.finish();
}

/** Where the next part of a host's data archive may go. */
type Place = "manifest" | "tables" | "documents" | "ended";

/** One host's data archive being read: its place, what it read so far, the open table and document. */
class HostArchiveReader {
	readonly #context: Context;
	#position = 0;
	#place: Place = "manifest";
	#host = "";
	#writes = 0;
	readonly #tables: HostTable[] = [];
	readonly #documents: HostDocument[] = [];
	readonly #addresses = new Set<string>();
	/** The record whose revisions may follow, with its last seq, its base's version and its value so far. */
	#document: { readonly record: DocumentRecord; seq: number; base: number | undefined; value: JsonValue } | undefined;

	constructor(context: Context) {
		this.#context = context;
	}

	take(value: unknown): void {
		const position = this.#position++;
		const part = checkPart(value, position, this.#context);
		const what = `importHostData: part ${position} (${part.kind})`;
		if (this.#place === "ended") throw invalid("args", `${what}: after the end`);
		if (this.#place === "manifest" || part.kind === "manifest") {
			this.#manifest(part, what);
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
		this.#writes++;
		switch (part.kind) {
			case "table":
				this.#table(part, what);
				return;
			case "put":
				this.#put(part, what);
				return;
			case "index":
				this.#index(part, what);
				return;
			case "document.create":
				this.#create(part.record, what);
				return;
			case "document.revision":
				this.#revision(part, what);
				return;
		}
	}

	finish(): HostArchive {
		if (this.#place !== "ended") throw invalid("args", "importHostData: the archive has no end part");
		return { host: this.#host, tables: this.#tables, documents: this.#documents };
	}

	/** The manifest, first and once: a format and schema this code reads, the address key it holds data of. */
	#manifest(part: ArchivePart, what: string): void {
		if (part.kind !== "manifest" || this.#place !== "manifest") {
			throw invalid("args", `${what}: the manifest comes first, once`);
		}
		if (part.format !== ARCHIVE_FORMAT)
			throw invalid("args", `${what}: format ${part.format} is not ${ARCHIVE_FORMAT}`);
		if (part.schema > STORE_SCHEMA)
			throw invalid("args", `${what}: schema ${part.schema} is newer than ${STORE_SCHEMA}`);
		if (part.host === undefined || storedText(part.host, what) !== part.host) {
			throw invalid("args", `${what}: not a host's data archive (no host)`);
		}
		this.#host = part.host;
		this.#place = "tables";
	}

	/** A table with exactly one host column, of the archive's address's kind; once; before the documents. */
	#table(write: Extract<ArchivePart, { readonly kind: "table" }>, what: string): void {
		if (this.#place !== "tables") throw invalid("args", `${what}: tables come before the documents`);
		if (this.#tables.some((table) => table.write.table === write.table)) {
			throw invalid("args", `${what}: table ${write.table} occurs twice`);
		}
		const hosts = Object.values(write.columns).filter((column) => column.host !== undefined);
		const column = hostColumn(write, kindOfKey(this.#host));
		if (hosts.length !== 1 || column === undefined) {
			throw invalid("args", `${what}: table ${write.table} has no single host column of ${kindOfKey(this.#host)}`);
		}
		this.#tables.push({ write, column, puts: [], indexes: [] });
	}

	/** A row of the open table, before its indexes, belonging to the archive's address. */
	#put(write: Extract<ArchivePart, { readonly kind: "put" }>, what: string): void {
		const table = this.#tables.at(-1);
		if (this.#place !== "tables" || table?.write.table !== write.table || table.indexes.length > 0) {
			throw invalid("args", `${what}: a put follows its table's table write, before its indexes`);
		}
		if (write.row[table.column] !== this.#host) {
			throw invalid("args", `${what}: a row that does not belong to ${this.#host}`);
		}
		table.puts.push(write);
	}

	/** An index of the open table, after its puts. */
	#index(write: Extract<ArchivePart, { readonly kind: "index" }>, what: string): void {
		const table = this.#tables.at(-1);
		if (this.#place !== "tables" || table?.write.table !== write.table) {
			throw invalid("args", `${what}: an index follows its table's table write and puts`);
		}
		table.indexes.push(write);
	}

	/**
	 * A live Chord record (history `none`) of the archive's address (its `host` and key), at an address no other
	 * record of the archive has, its address well-formed text. The record before it must have ended well.
	 */
	#create(record: DocumentRecord, what: string): void {
		this.#endDocument(what);
		this.#place = "documents";
		const { owner, namespace, kind, key, host, history, retiredAt, meta } = record;
		if (host !== this.#host || key !== this.#host) {
			throw invalid("args", `${what}: a record that does not belong to ${this.#host}`);
		}
		if (history !== "none" || retiredAt !== undefined || meta !== undefined) {
			throw invalid("args", `${what}: not a live Chord record`);
		}
		for (const text of [owner, namespace, kind]) {
			if (storedText(text, what) !== text) throw invalid("args", `${what}: an address is not well-formed text`);
		}
		const address = JSON.stringify([owner, namespace, kind]);
		if (this.#addresses.has(address)) throw invalid("args", `${what}: a second record at one address`);
		this.#addresses.add(address);
		this.#document = { record, seq: 0, base: undefined, value: null };
	}

	/** A revision of the record before it, in seq order, from a base, each delta at its base's version, applied. */
	#revision(part: Extract<ArchivePart, { readonly kind: "document.revision" }>, what: string): void {
		const document = this.#document;
		if (document === undefined || document.record.id !== part.id || part.seq <= document.seq) {
			throw invalid("args", `${what}: a revision follows its record's create, in seq order`);
		}
		const { content } = part;
		if (content.kind === "base") {
			document.base = content.version;
			document.value = content.value as JsonValue;
		} else if (document.base !== content.version) {
			throw invalid("args", `${what}: a delta without a base at its version`);
		} else {
			try {
				document.value = apply(document.value, content.ops as readonly Op[]);
			} catch (error) {
				throw invalid("args", `${what}: a delta that does not apply (${String(error)})`);
			}
		}
		document.seq = part.seq;
	}

	/** The record before ends well: its last base at the record's version; its value kept. */
	#endDocument(what: string): void {
		const document = this.#document;
		this.#document = undefined;
		if (document === undefined) return;
		if (document.base !== document.record.version) {
			throw invalid("args", `${what}: record ${document.record.id} has no base at its version`);
		}
		this.#documents.push({ record: document.record, value: document.value });
	}
}

/** How a host data operation commits: the host's fence and its reads in the step. */
export type HostCommit = {
	/** Admits the commit (the caller's context, the host open) and adopts what `after` read, after `COMMIT`. */
	readonly fence: CommitFence;
	/** Staged after the operation's writes, in the same step: what the live owners hold, read again. */
	readonly after: readonly StagedWrite[];
};

/** What `importHostData` does with an archive: under `target` (canonical), `existing`, with the tables' histories. */
export type HostImportPlan = {
	readonly target: string;
	readonly existing: "refuse" | "replace";
	/** The newest definitions (from the owners' code) of the archive's tables whose rows must migrate, by SQL name. */
	readonly histories: ReadonlyMap<string, TableDefinition>;
};

/**
 * The archive's tables whose rows must migrate before they can be merged into `store` (recorded at a newer version,
 * or exported `migrating`): their owners must be live for their histories. By SQL name.
 */
export function tablesToMigrate(store: Store, archive: HostArchive): string[] {
	// Stores are Chord's own: `openStore` and `importStore` made them.
	const chord = store as ChordStore;
	return archive.tables.flatMap(({ write }) => {
		const recorded = chord.table(write.table);
		const migrates = recorded !== undefined && (recorded.version > write.version || write.state === "migrating");
		return migrates ? [write.table] : [];
	});
}

/**
 * The owners (object types) whose data an operation on host `key` changes: of tables with a `host(...)` column of its
 * kind (recorded, and the archive's), of records belonging to it, and of the archive's records.
 */
export async function hostDataOwners(
	store: Store,
	key: string,
	archive: HostArchive | undefined,
	context: Context,
): Promise<Set<string>> {
	// Stores are Chord's own: `openStore` and `importStore` made them.
	const chord = store as ChordStore;
	const kind = kindOfKey(key);
	const owners = new Set<string>();
	const ownerOf = (table: string) => table.slice(0, table.indexOf(":"));
	for (const record of chord.tables.values())
		if (hostColumn(record, kind) !== undefined) owners.add(ownerOf(record.table));
	for (const { write } of archive?.tables ?? []) owners.add(ownerOf(write.table));
	for (const { record } of archive?.documents ?? []) owners.add(record.owner);
	const rows = await chord.read(
		(executor) =>
			executor.all<{ readonly owner: string }>(`SELECT DISTINCT owner FROM ${TABLES.documents} WHERE host = ?`, key),
		context,
	);
	for (const { owner } of rows) owners.add(owner);
	return owners;
}

/**
 * Imports `archive` into `store` in one commit (spec §4) under `plan.target`: the store's data of it refused or, with
 * `existing: "replace"`, retired and deleted first; tables the store does not record created from the archive,
 * recorded ones checked against the archive's metadata (the recorded host column decides) or migrated through their
 * histories; rows that would replace another row refused; records created with fresh ids at the commit's seq, their
 * values as bases; `commit.after` staged after it. Internal: the host coordinates it.
 */
export async function importHostData(
	store: Store,
	archive: HostArchive,
	plan: HostImportPlan,
	commit: HostCommit,
	context: Context,
): Promise<HostDataCounts> {
	if (kindOfKey(plan.target) !== kindOfKey(archive.host)) {
		throw invalid("args", `importHostData: data of ${archive.host} cannot belong to ${plan.target}, another kind`);
	}
	let counts: HostDataCounts = { documents: 0, rows: 0 };
	const apply = async (step: Step, writes: StoreWrite[]): Promise<void> => {
		counts = await applyImport(step, archive, plan, writes, context);
	};
	await commitOperation(store, apply, commit, context);
	return counts;
}

/**
 * Deletes the data of host `key` (canonical) from `store` in one commit: every record whose `host` is the key retired,
 * every row holding it in a `host(...)` column of its kind deleted (`deleteWhere`, counted). Internal, as import.
 */
export async function deleteHostData(
	store: Store,
	key: string,
	commit: HostCommit,
	context: Context,
): Promise<HostDataCounts> {
	let counts: HostDataCounts = { documents: 0, rows: 0 };
	const apply = async (step: Step, writes: StoreWrite[]): Promise<void> => {
		counts = await removeHostData(step, key, writes);
	};
	await commitOperation(store, apply, commit, context);
	return counts;
}

/** Commits `apply`'s writes, then `commit.after`, as one seq under `commit.fence`. */
async function commitOperation(
	store: Store,
	apply: (step: Step, writes: StoreWrite[]) => Promise<void>,
	commit: HostCommit,
	context: Context,
): Promise<void> {
	const write: StagedWrite = {
		order: "write",
		apply: async (step) => {
			const writes: StoreWrite[] = [];
			await apply(step, writes);
			return writes;
		},
	};
	// Stores are Chord's own: `openStore` and `importStore` made them.
	await (store as ChordStore).commit([write, ...commit.after], commit.fence, context);
}

/** The import inside its commit step: the existing data first, then the tables, the rows, the records. */
async function applyImport(
	step: Step,
	archive: HostArchive,
	plan: HostImportPlan,
	writes: StoreWrite[],
	context: Context,
): Promise<HostDataCounts> {
	const { target, existing } = plan;
	if (existing === "replace") await removeHostData(step, target, writes);
	else if (await hasHostData(step, target)) {
		throw invalid("args", `importHostData: ${target} has data in this store (import with existing: "replace")`);
	}
	let rows = 0;
	for (const table of archive.tables) {
		rows += await importTable(step, table, archive.host, plan, writes, context);
	}
	for (const { record, value } of archive.documents) {
		const { owner, namespace, kind, version, fingerprint } = record;
		const address = { owner, namespace, kind, key: target, host: target };
		const create = createDocument(address, { version, fingerprint, value }, JSON.stringify(value));
		writes.push(...(await create.apply(step)));
	}
	return { documents: archive.documents.length, rows };
}

/**
 * One table of the archive: created with its indexes when the store does not record it; recorded newer here, or
 * exported `migrating`, its rows migrate through the table's history first. Every row must then hold `target` in the
 * recorded table's own host column (whatever the archive's metadata says) and take no other row's key.
 */
async function importTable(
	step: Step,
	table: HostTable,
	source: string,
	plan: HostImportPlan,
	writes: StoreWrite[],
	context: Context,
): Promise<number> {
	const { write, indexes } = table;
	const what = `importHostData: table ${write.table}`;
	// The copy's rewrite, on the archive's own host column (a migration's renames carry it along).
	const puts = table.puts.map((put) =>
		put.row[table.column] === plan.target ? put : { ...put, row: { ...put.row, [table.column]: plan.target } },
	);
	const recorded = step.table(write.table);
	let placed: readonly Extract<TableWrite, { readonly kind: "put" }>[] = puts;
	if (recorded === undefined) {
		for (const each of [write, ...indexes]) {
			await applyWrite(step, each, what);
			writes.push(each);
		}
	} else {
		if (recorded.state !== "ready") throw invalid("args", `${what}: migrating here; open its owner first`);
		if (write.version > recorded.version) {
			throw invalid(
				"args",
				`${what}: at version ${write.version} in the archive, newer than ${recorded.version} here`,
			);
		}
		if (write.version < recorded.version || write.state === "migrating") {
			const history = plan.histories.get(write.table);
			if (history === undefined) {
				throw invalid(
					"args",
					`${what}: at version ${write.version}, ${recorded.version} here; its owner is not live`,
				);
			}
			placed = migrateRows(write, puts, history, recorded, context);
		}
	}
	const record = step.table(write.table)!;
	const column = hostColumn(record, kindOfKey(source));
	if (column === undefined) throw invalid("args", `${what}: no host column of ${kindOfKey(source)} here`);
	const exists = `SELECT 1 AS found FROM ${quote(write.table)} WHERE ${record.key.map((name) => `${quote(name)} = ?`).join(" AND ")}`;
	for (const put of placed) {
		if (put.row[column] !== plan.target) {
			throw invalid("args", `${what}: a row that does not belong to ${plan.target}`);
		}
		const key: SqliteValue[] = record.key.map((name) =>
			toSqlite(checkScalar(record.columns[name]!.type as "str" | "int", put.row[name], `${what}: key`)),
		);
		if ((await step.get(exists, ...key)) !== undefined) {
			throw invalid("args", `${what}: a row with key ${JSON.stringify(key)} exists (of another address)`);
		}
		await applyWrite(step, put, what);
		step.rows++;
		writes.push(put);
	}
	return placed.length;
}

/** Retires the records of host `key` and deletes its rows in `step`, recording the writes; returns the counts. */
async function removeHostData(step: Step, key: string, writes: StoreWrite[]): Promise<HostDataCounts> {
	const records = await listHostRecords(step, key, 0, Number.MAX_SAFE_INTEGER);
	for (const { id, revision } of records) writes.push(...(await retireDocument(id, revision).apply(step)));
	let rows = 0;
	for (const [table, column] of hostTables(step, kindOfKey(key))) {
		const count = await step.runCounted(`DELETE FROM ${quote(table)} WHERE ${quote(column)} = ?`, key);
		step.rows += count;
		rows += count;
		writes.push({ kind: "deleteWhere", table, where: { eq: [column, key] }, count });
	}
	return { documents: records.length, rows };
}

/** Whether `step`'s store holds a record or a row of host `key`. */
async function hasHostData(step: Step, key: string): Promise<boolean> {
	if ((await listHostRecords(step, key, 0, 1)).length > 0) return true;
	for (const [table, column] of hostTables(step, kindOfKey(key))) {
		const found = await step.get(`SELECT 1 AS found FROM ${quote(table)} WHERE ${quote(column)} = ? LIMIT 1`, key);
		if (found !== undefined) return true;
	}
	return false;
}

/** The recorded tables with a `host(...)` column of `kind`, with that column's name. */
function hostTables(step: Step, kind: string): [table: string, column: string][] {
	return step.records().flatMap((record) => {
		const column = hostColumn(record, kind);
		return column === undefined ? [] : [[record.table, column] as [string, string]];
	});
}
