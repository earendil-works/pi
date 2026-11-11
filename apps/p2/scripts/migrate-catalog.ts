// Moves p2's session catalog from `catalog.sqlite` (plain SQLite, schema versions 1 to 4) into the server's Chord store,
// as the rows of the catalog's table keyed by each session's address (`plugins/sessions/catalog.ts`, decision
// "Documents and table rows can belong to a host"). Part of `npm run migrate-data` (`migrate-data.ts`), offline.
//
// Every row is written in one transaction of a host of its own on the server's store, serving the catalog with only its
// table, then read back from the store reopened and compared; only then does `catalog.sqlite` (with its journal files)
// move to `pre-catalog-backup/`. A crash before the move redoes nothing it finished: a table that holds rows is not
// written again, only the backup is left.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { constant } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { arr, compile, type JsonSchema, type Static } from "@earendil-works/pi-schema";
import { BY_ACTIVITY, type SessionRow, SessionRows } from "../plugins/sessions/catalog.ts";
import { BranchSchema, Catalog } from "../plugins/sessions/contract.ts";
import { createHost, defineFacet, Session } from "../src/runtime/chord.ts";
import { hostStore, openHostStore, serverDirectory } from "../src/runtime/host-dirs.ts";
import { HOST } from "../src/runtime/principals.ts";
import { ModelRefSchema } from "../src/runtime/schemas.ts";

/** What the catalog step did: moved now (with how many sessions), moved before, or there was no `catalog.sqlite`. */
export type CatalogMigration =
	| { readonly kind: "migrated"; readonly sessions: number }
	| { readonly kind: "done" }
	| { readonly kind: "absent" };

/** A SQLite file and its journal files. */
const JOURNAL = ["", "-wal", "-shm"];

/** The old catalog's placeholder title: before `titleEdited` (version 3), any other title counted as given. */
const PLACEHOLDER = "New session";

/**
 * Migrates `<dataDir>/catalog.sqlite` into the server store of `work` (`dataDir` itself, or a dry run's directory: the
 * server's store is copied there first, and nothing in `dataDir` changes).
 */
export async function migrateCatalog(dataDir: string, work: string, dryRun: boolean): Promise<CatalogMigration> {
	const old = join(dataDir, "catalog.sqlite");
	if (!existsSync(old)) return { kind: "absent" };
	const serverDir = serverDirectory(work);
	if (dryRun && !existsSync(hostStore(serverDir)) && existsSync(hostStore(serverDirectory(dataDir))))
		copySqlite(hostStore(serverDirectory(dataDir)), hostStore(serverDir));
	const scratch = mkdtempSync(join(tmpdir(), "p2-migrate-catalog-"));
	try {
		copySqlite(old, join(scratch, "catalog.sqlite"));
		const rows = readOldCatalog(join(scratch, "catalog.sqlite"));
		const written = await withCatalog(serverDir, rows);
		if (written === "kept") {
			if (!dryRun) backup(dataDir);
			return { kind: "done" };
		}
		// Verified on the store as reopened: what was written is what is stored.
		const stored = await withCatalog(serverDir, []);
		if (stored === "kept" || !sameRows(stored, rows)) throw new Error("The catalog differs after the move");
		if (!dryRun) backup(dataDir);
		return { kind: "migrated", sessions: rows.length };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Opens the server store in `serverDir` under a host serving the catalog with only its table: writes `rows` in one
 * transaction when the table is empty (`"kept"` when it held rows already), and answers the rows it holds.
 */
async function withCatalog(serverDir: string, rows: readonly SessionRow[]): Promise<SessionRow[] | "kept"> {
	const store = await openHostStore(serverDir, { outbox: false }, context);
	const errors: unknown[] = [];
	const host = createHost({ principal: HOST, store, onError: (error) => errors.push(error) });
	let kept = false;
	const stored: SessionRow[] = [];
	const refused = () => Promise.reject(new Error("The catalog is open for its migration only"));
	const facet = defineFacet((h) =>
		h.serve(Catalog, (_params, self) => {
			const table = self.table(SessionRows);
			self.open(
				async (ctx) => {
					if (rows.length > 0) {
						if ((await table.count(BY_ACTIVITY, ctx)) > 0) {
							kept = true;
							return null;
						}
						await self.tx((tx) => {
							for (const row of rows) tx.put(table, row);
						}, ctx);
					}
					for await (const row of table.rows(BY_ACTIVITY, ctx)) stored.push(row);
					return null;
				},
				() => {},
			);
			return {
				sessions: constant([]),
				get: refused,
				create: refused,
				activity: refused,
				update: refused,
			};
		}),
	);
	try {
		await host.load([{ name: "p2.migrate-catalog", facet }], context);
		const ref = await host.get(Catalog, {}, context);
		try {
			if (errors.length) throw errors[0];
			return kept ? "kept" : stored;
		} finally {
			ref.release();
		}
	} finally {
		await host.close(context);
		await store.close(context);
	}
}

/**
 * The rows of the old catalog at `path` (a copy: opening it may checkpoint its journal), as the table keeps them, from
 * any of its schema versions: before 2 without `env`, before 3 without `titleEdited` (a title other than the
 * placeholder counted as given), before 4 without `main` and `branches`.
 */
function readOldCatalog(path: string): SessionRow[] {
	const db = new DatabaseSync(path);
	try {
		const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
		if (version < 1 || version > 4) throw new Error(`catalog.sqlite: unsupported schema version ${version}`);
		const columns = new Set(
			db
				.prepare("PRAGMA table_info(sessions)")
				.all()
				.map((column) => String(column.name)),
		);
		return db
			.prepare("SELECT * FROM sessions ORDER BY id")
			.all()
			.map((row) => {
				const id = String(row.id);
				const env = columns.has("env") && row.env !== null ? String(row.env) : undefined;
				const title = String(row.title);
				const archivedAt = row.archivedAt === null ? undefined : Number(row.archivedAt);
				return {
					session: Session({ id }),
					cwd: String(row.cwd),
					...(env === undefined ? {} : { env }),
					title,
					titleEdited: columns.has("titleEdited") ? row.titleEdited === 1 : title !== PLACEHOLDER,
					createdAt: Number(row.createdAt),
					updatedAt: Number(row.updatedAt),
					...(archivedAt === undefined ? {} : { archivedAt }),
					pinned: row.pinned === 1,
					model: parsed(ModelRefSchema, row.model, `${id}: model`),
					thinkingLevel: String(row.thinkingLevel),
					main: columns.has("main") ? Number(row.main) : 1,
					branches: columns.has("branches") ? parsed(arr(BranchSchema), row.branches, `${id}: branches`) : [],
				};
			});
	} finally {
		db.close();
	}
}

/** The JSON text `cell` checked against `schema`; `what` names it in the error. */
function parsed<S extends JsonSchema>(schema: S, cell: unknown, what: string): Static<S> {
	const value: unknown = JSON.parse(String(cell));
	const validator = compile(schema);
	if (!validator.check(value)) throw new Error(`catalog.sqlite: ${what} is not valid`);
	return value;
}

/** Whether `stored` holds exactly `rows` (by session). */
function sameRows(stored: readonly SessionRow[], rows: readonly SessionRow[]): boolean {
	const byKey = (list: readonly SessionRow[]) => [...list].sort((a, b) => a.session.key.localeCompare(b.session.key));
	return isDeepStrictEqual(byKey(stored), byKey(rows));
}

/** Moves `catalog.sqlite` with its journal files into `pre-catalog-backup/`. */
function backup(dataDir: string): void {
	for (const suffix of JOURNAL) {
		const from = join(dataDir, `catalog.sqlite${suffix}`);
		if (!existsSync(from)) continue;
		mkdirSync(join(dataDir, "pre-catalog-backup"), { recursive: true, mode: 0o700 });
		renameSync(from, join(dataDir, "pre-catalog-backup", `catalog.sqlite${suffix}`));
	}
}

/** Copies the SQLite file `from` with its journal files to `to` (offline: nothing writes them meanwhile). */
function copySqlite(from: string, to: string): void {
	mkdirSync(join(to, ".."), { recursive: true, mode: 0o700 });
	for (const suffix of JOURNAL) if (existsSync(`${from}${suffix}`)) copyFileSync(`${from}${suffix}`, `${to}${suffix}`);
}
