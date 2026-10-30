// The store's own SQL schema (slice 6a §2): its metadata, the recorded table definitions, the documents engine's
// records and revisions, and the outbox; versioned by `applySqliteMigrations`. Declared tables are named
// `"<owner>:<table>"`, so no name here can meet one of them.

import { applySqliteMigrations, type SqliteDatabase, type SqliteMigration } from "../../sqlite/index.ts";

/** The store's tables. */
export const TABLES = {
	meta: "chord_meta",
	tables: "chord_tables",
	documents: "chord_documents",
	revisions: "chord_revisions",
	outbox: "chord_outbox",
} as const;

/**
 * The schema history; never change an entry, append one (nothing is deployed yet: slice 6b changed entry 1 in place).
 * `chord_meta` is one row: `last_seq`, the allocator's next id (D3; from 2, id 1 is Durable's root conversation), and
 * the outbox setting with its floor (the seq it starts after, advanced by `trim`). A document record keeps its
 * history rule (R1), its current base's version and fingerprint and a `revision` counter for the conditional
 * `UPDATE`; the partial unique index refuses two live records at one address. Entry 2 adds the indexes of reads at a
 * point (slice 6b §1.5): an address's incarnations by creation, an owner's namespace by id, a document's bases (a
 * partial index: deltas write no entry).
 */
const MIGRATIONS: readonly SqliteMigration[] = [
	{
		version: 1,
		statements: [
			`CREATE TABLE ${TABLES.meta} (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				last_seq INTEGER NOT NULL,
				next_id INTEGER NOT NULL,
				outbox INTEGER NOT NULL CHECK (outbox IN (0, 1)),
				outbox_floor INTEGER NOT NULL
			) STRICT`,
			`INSERT INTO ${TABLES.meta} (singleton, last_seq, next_id, outbox, outbox_floor) VALUES (1, 0, 2, 0, 0)`,
			`CREATE TABLE ${TABLES.tables} (name TEXT PRIMARY KEY, definition TEXT NOT NULL) STRICT, WITHOUT ROWID`,
			`CREATE TABLE ${TABLES.documents} (
				id INTEGER PRIMARY KEY,
				owner TEXT NOT NULL,
				namespace TEXT NOT NULL,
				kind TEXT NOT NULL,
				key TEXT NOT NULL,
				history TEXT NOT NULL CHECK (history IN ('none', 'latest', 'rewindable')),
				created_at INTEGER NOT NULL,
				retired_at INTEGER,
				meta TEXT,
				revision INTEGER NOT NULL,
				version INTEGER NOT NULL,
				fingerprint TEXT NOT NULL
			) STRICT`,
			`CREATE UNIQUE INDEX chord_documents_live ON ${TABLES.documents} (owner, namespace, kind, key)
				WHERE retired_at IS NULL`,
			`CREATE TABLE ${TABLES.revisions} (
				document_id INTEGER NOT NULL,
				seq INTEGER NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
				version INTEGER NOT NULL,
				content TEXT NOT NULL,
				PRIMARY KEY (document_id, seq)
			) STRICT, WITHOUT ROWID`,
			`CREATE TABLE ${TABLES.outbox} (
				seq INTEGER PRIMARY KEY,
				format INTEGER NOT NULL,
				next_id INTEGER NOT NULL,
				writes TEXT NOT NULL
			) STRICT`,
		],
	},
	{
		version: 2,
		statements: [
			`CREATE INDEX chord_documents_address ON ${TABLES.documents} (owner, namespace, kind, key, created_at)`,
			`CREATE INDEX chord_documents_scope ON ${TABLES.documents} (owner, namespace, id)`,
			// Only bases are looked up by it (a load's newest base at or below a point): deltas write no entry.
			`CREATE INDEX chord_revisions_bases ON ${TABLES.revisions} (document_id, seq) WHERE kind = 'base'`,
		],
	},
];

/** The store's schema version: the newest entry of its history (archives carry it). */
export const STORE_SCHEMA = MIGRATIONS.at(-1)!.version;

/** The store's metadata row, as `openStore` reads it once. */
export type MetaRow = {
	readonly last_seq: number;
	readonly next_id: number;
	readonly outbox: number;
	readonly outbox_floor: number;
};

/**
 * Brings `db` to the store's newest schema (one transaction) and checks that it stores text as UTF-8 (the store
 * compares text by its bytes); returns the metadata row. A store already there is read in one statement, without the
 * migrations' write transaction (most opens: the cost of a reopen).
 */
export async function applyStoreSchema(db: SqliteDatabase): Promise<MetaRow> {
	const current = await currentMeta(db);
	if (current !== undefined) return current;
	const encoding = await db.get<{ readonly encoding: string }>("PRAGMA encoding");
	if (encoding?.encoding !== "UTF-8")
		throw new Error(`store: the database encoding is ${encoding?.encoding}, not UTF-8`);
	await applySqliteMigrations(db, MIGRATIONS, { table: "chord_store_schema" });
	const meta = await db.get<MetaRow>(
		`SELECT last_seq, next_id, outbox, outbox_floor FROM ${TABLES.meta} WHERE singleton = 1`,
	);
	if (meta === undefined) throw new Error("store: the metadata row is missing");
	return meta;
}

/** The schema version, the encoding and the metadata row of a store, in one read. */
const CURRENT_META = `SELECT s.version, e.encoding, m.last_seq, m.next_id, m.outbox, m.outbox_floor
	FROM chord_store_schema s, pragma_encoding e, ${TABLES.meta} m WHERE s.singleton = 1 AND m.singleton = 1`;

/** The metadata row of a store at the newest schema in UTF-8; `undefined` for any other database. */
async function currentMeta(db: SqliteDatabase): Promise<MetaRow | undefined> {
	let row: (MetaRow & { readonly version: number; readonly encoding: string }) | undefined;
	try {
		row = await db.get(CURRENT_META);
	} catch {
		// A database without the store's tables (new, or not a store) or a backend without `pragma_encoding`: the
		// migrations' path creates, refuses or reads it.
		return undefined;
	}
	if (row === undefined || row.version !== STORE_SCHEMA || row.encoding !== "UTF-8") return undefined;
	return { last_seq: row.last_seq, next_id: row.next_id, outbox: row.outbox, outbox_floor: row.outbox_floor };
}
