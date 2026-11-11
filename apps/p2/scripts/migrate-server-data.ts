// Moves p2's share links, guests and grants (`shares.sqlite`, schema versions 1 and 2) and its sessions' subagent lists
// (`subagents.sqlite`) into the server's Chord store, as the tables of `Shares` and `ChildStore`
// (`plugins/sharing/store.ts`, `plugins/subagents/children.ts`). Part of `npm run migrate-data` (`migrate-data.ts`),
// offline.
//
// Each file is written in one transaction of a host of its own on the server's store, serving the owner's contract
// with only its tables, then read back from the store reopened and compared; only then does the file (with its journal
// files) move to `pre-server-data-backup/`. A crash before the move redoes nothing it finished: tables that hold rows are
// not written again, only the backup is left.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { constant, query } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { arr, compile, obj, opt, str } from "@earendil-works/pi-schema";
import { Shares } from "../plugins/sharing/contract.ts";
import {
	GrantRows,
	type GrantStored,
	GuestRows,
	type GuestStored,
	LinkRows,
	type LinkStored,
} from "../plugins/sharing/store.ts";
import { type ChildRow, ChildRows } from "../plugins/subagents/children.ts";
import { type Child, ChildSchema, ChildStore } from "../plugins/subagents/contract.ts";

/** A child as `subagents.sqlite` kept it: version 1 rows have an own `cwd` instead of a `location`. */
const StoredChildSchema = obj({ ...propertiesOf(ChildSchema), cwd: opt(str()) });

import { type Ctx, createHost, defineFacet, Session } from "../src/runtime/chord.ts";
import { hostStore, openHostStore, serverDirectory } from "../src/runtime/host-dirs.ts";
import { HOST } from "../src/runtime/principals.ts";
import { propertiesOf } from "../src/runtime/schema.ts";

/** What one file's step did: moved now (with how many rows), moved before, or there was no such file. */
export type FileMigration =
	| { readonly kind: "migrated"; readonly rows: number }
	| { readonly kind: "done" }
	| { readonly kind: "absent" };

/** A SQLite file and its journal files. */
const JOURNAL = ["", "-wal", "-shm"];
const BACKUP = "pre-server-data-backup";

/** `Shares`' rows. */
type ShareTables = { readonly links: LinkStored[]; readonly guests: GuestStored[]; readonly grants: GrantStored[] };
/** `ChildStore`'s rows. */
type ChildTables = { readonly children: ChildRow[] };

/**
 * Migrates `shares.sqlite` and `subagents.sqlite` of `dataDir` into the server store of `work` (`dataDir` itself, or a
 * dry run's directory: the server's store is copied there first, and nothing in `dataDir` changes).
 */
export async function migrateServerData(
	dataDir: string,
	work: string,
	dryRun: boolean,
): Promise<{ readonly shares: FileMigration; readonly subagents: FileMigration }> {
	const serverDir = serverDirectory(work);
	if (dryRun && !existsSync(hostStore(serverDir)) && existsSync(hostStore(serverDirectory(dataDir))))
		copySqlite(hostStore(serverDirectory(dataDir)), hostStore(serverDir));
	return {
		shares: await migrateFile(dataDir, serverDir, dryRun, SHARES),
		subagents: await migrateFile(dataDir, serverDir, dryRun, children(serverDir)),
	};
}

/** A file's owner: its facet, how to activate it, and how to read the old file's rows. */
type Step<T extends object> = {
	readonly file: string;
	readonly facet: (use: (owned: Owned<T>) => void) => ReturnType<typeof defineFacet>;
	readonly activate: (ctx: Ctx) => Promise<unknown>;
	readonly read: (path: string) => T;
	readonly count: (rows: T) => number;
};

const SHARES: Step<ShareTables> = {
	file: "shares.sqlite",
	facet: (use) => sharesFacet(use),
	activate: (ctx) => ctx.get(Shares, {}),
	read: (path) => readShares(path),
	count: (rows) => rows.links.length + rows.guests.length + rows.grants.length,
};

/** `subagents.sqlite`, its own-cwd children placed on their sessions' environments in `serverDir`'s catalog. */
const children = (serverDir: string): Step<ChildTables> => ({
	file: "subagents.sqlite",
	facet: (use) => childrenFacet(use),
	activate: (ctx) => ctx.get(ChildStore, {}),
	read: (path) => readChildren(path, sessionEnvs(serverDir)),
	count: (rows) => rows.children.length,
});

/** One file: read from a copy, written as its owner's tables, verified on the store reopened, then backed up. */
async function migrateFile<T extends object>(
	dataDir: string,
	serverDir: string,
	dryRun: boolean,
	step: Step<T>,
): Promise<FileMigration> {
	const old = join(dataDir, step.file);
	if (!existsSync(old)) return { kind: "absent" };
	const scratch = mkdtempSync(join(tmpdir(), "p2-migrate-server-data-"));
	try {
		copySqlite(old, join(scratch, step.file));
		const rows = step.read(join(scratch, step.file));
		if (step.count(rows) > 0) {
			const written = await withTables(serverDir, step.facet, step.activate, rows);
			if (written === "kept") {
				if (!dryRun) backup(dataDir, step.file);
				return { kind: "done" };
			}
			// Verified on the store as reopened: what was written is what is stored.
			const stored = await withTables(serverDir, step.facet, step.activate, undefined);
			if (stored === "kept" || !sameRows(stored, rows)) throw new Error(`${step.file} differs after the move`);
		}
		if (!dryRun) backup(dataDir, step.file);
		return { kind: "migrated", rows: step.count(rows) };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * One owner's tables on the server store: `write` puts the rows once every table is empty, `read` reads them all.
 * `tables` lists the handles of the factory that declared them.
 */
type Owned<T> = {
	readonly empty: (ctx: Ctx) => Promise<boolean>;
	readonly write: (rows: T, ctx: Ctx) => Promise<void>;
	readonly read: (ctx: Ctx) => Promise<T>;
};

/** `Shares`' tables, written and read in its own transactions. */
const sharesFacet = (use: (owned: Owned<ShareTables>) => void) =>
	defineFacet((h) =>
		h.serve(Shares, (_params, self) => {
			const links = self.table(LinkRows);
			const guests = self.table(GuestRows);
			const grants = self.table(GrantRows);
			const refused = () => Promise.reject(new Error("Shares is open for its migration only"));
			use({
				empty: async (ctx) =>
					(await links.count(query(LinkRows), ctx)) +
						(await guests.count(query(GuestRows), ctx)) +
						(await grants.count(query(GrantRows), ctx)) ===
					0,
				write: (rows, ctx) =>
					self.tx((tx) => {
						for (const row of rows.links) tx.put(links, row);
						for (const row of rows.guests) tx.put(guests, row);
						for (const row of rows.grants) tx.put(grants, row);
					}, ctx),
				read: async (ctx) => ({
					links: await all(links.rows(query(LinkRows), ctx)),
					guests: await all(guests.rows(query(GuestRows), ctx)),
					grants: await all(grants.rows(query(GrantRows), ctx)),
				}),
			});
			return {
				links: constant([]),
				emails: constant([]),
				people: constant([]),
				authenticate: refused,
				authenticateEmail: refused,
				grant: refused,
				active: refused,
				link: refused,
				share: refused,
				remove: refused,
				join: refused,
			};
		}),
	);

/** `ChildStore`'s table, written and read in its own transactions. */
const childrenFacet = (use: (owned: Owned<ChildTables>) => void) =>
	defineFacet((h) =>
		h.serve(ChildStore, (_params, self) => {
			const children = self.table(ChildRows);
			use({
				empty: async (ctx) => (await children.count(query(ChildRows), ctx)) === 0,
				write: (rows, ctx) =>
					self.tx((tx) => {
						for (const row of rows.children) tx.put(children, row);
					}, ctx),
				read: async (ctx) => ({ children: await all(children.rows(query(ChildRows), ctx)) }),
			});
			return {
				children: constant({}),
				report: () => Promise.reject(new Error("ChildStore is open for its migration only")),
			};
		}),
	);

/** Every item of `items`. */
async function all<T>(items: AsyncIterable<T>): Promise<T[]> {
	const list: T[] = [];
	for await (const item of items) list.push(item);
	return list;
}

/**
 * Opens the server store in `serverDir` under a host serving one owner (`facet`, which `use`s its tables; `activate`
 * gets it): writes `rows` in one transaction when every table is empty (`"kept"` when one held rows already), or with
 * `rows` undefined only reads; answers the rows the tables hold.
 */
async function withTables<T extends object>(
	serverDir: string,
	facet: (use: (owned: Owned<T>) => void) => ReturnType<typeof defineFacet>,
	activate: (ctx: Ctx) => Promise<unknown>,
	rows: T | undefined,
): Promise<T | "kept"> {
	const store = await openHostStore(serverDir, { outbox: false }, context);
	const errors: unknown[] = [];
	const host = createHost({ principal: HOST, store, onError: (error) => errors.push(error) });
	let owned: Owned<T> | undefined;
	try {
		await host.load(
			[
				{
					name: "p2.migrate-server-data",
					facet: facet((value) => {
						owned = value;
					}),
				},
			],
			context,
		);
		return await host.root(async (ctx) => {
			// Activating the owner declares its tables (and hands them over).
			await activate(ctx);
			if (errors.length) throw errors[0];
			if (owned === undefined) throw new Error("The owner did not activate");
			if (rows !== undefined) {
				if (!(await owned.empty(ctx))) return "kept";
				await owned.write(rows, ctx);
			}
			return owned.read(ctx);
		}, context);
	} finally {
		await host.close(context);
		await store.close(context);
	}
}

/**
 * The links, guests and grants of `shares.sqlite` at `path` (a copy), as `Shares`' tables keep them. Version 1 (one
 * guest per link) becomes a guest with one grant, the session of its link, as `ShareDb` migrated it.
 */
function readShares(path: string): ShareTables {
	const db = new DatabaseSync(path);
	try {
		const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
		if (version !== 1 && version !== 2) throw new Error(`shares.sqlite: unsupported schema version ${version}`);
		const linkRows = db.prepare("SELECT id,session,mode,token FROM links").all();
		const links: LinkStored[] = linkRows.map((row) => ({
			session: Session({ id: String(row.session) }),
			mode: mode(row.mode),
			id: String(row.id),
			token: String(row.token),
		}));
		const sessionOfLink = new Map(linkRows.map((row) => [String(row.id), String(row.session)]));
		const modeOfLink = new Map(linkRows.map((row) => [String(row.id), mode(row.mode)]));
		const guests: GuestStored[] = [];
		const grants: GrantStored[] = [];
		if (version === 1) {
			for (const row of db.prepare("SELECT id,linkId,name,secretHash,removed,revision,lastSeen FROM guests").all()) {
				const session = sessionOfLink.get(String(row.linkId));
				guests.push({
					id: String(row.id),
					name: String(row.name),
					secretHash: String(row.secretHash),
					revision: Number(row.revision),
					lastSeen: Number(row.lastSeen),
				});
				if (session === undefined) continue;
				grants.push({
					session: Session({ id: session }),
					guest: String(row.id),
					mode: modeOfLink.get(String(row.linkId)) ?? "view",
					linkId: String(row.linkId),
					removed: row.removed === 1,
					grantedAt: Number(row.lastSeen),
				});
			}
		} else {
			for (const row of db.prepare("SELECT id,name,secretHash,email,revision,lastSeen FROM guests").all())
				guests.push({
					id: String(row.id),
					name: String(row.name),
					...(row.secretHash === null ? {} : { secretHash: String(row.secretHash) }),
					...(row.email === null ? {} : { email: String(row.email) }),
					revision: Number(row.revision),
					lastSeen: Number(row.lastSeen),
				});
			for (const row of db.prepare("SELECT guest,session,mode,linkId,removed,grantedAt FROM grants").all())
				grants.push({
					session: Session({ id: String(row.session) }),
					guest: String(row.guest),
					mode: mode(row.mode),
					...(row.linkId === null ? {} : { linkId: String(row.linkId) }),
					removed: row.removed === 1,
					grantedAt: Number(row.grantedAt),
				});
		}
		return { links, guests, grants };
	} finally {
		db.close();
	}
}

/**
 * Each session's children in `subagents.sqlite` at `path` (a copy), as `ChildStore`'s table keeps them. A child stored
 * with an own cwd (before locations) is placed on its session's environment, as `ChildStore` placed it (a session could
 * not change machines while it had such children): `envs` maps each session to it.
 */
function readChildren(path: string, envs: ReadonlyMap<string, string | null>): ChildTables {
	const db = new DatabaseSync(path);
	const valid = compile(arr(StoredChildSchema));
	try {
		const children: ChildRow[] = db
			.prepare("SELECT session,value FROM children")
			.all()
			.map((row) => {
				const session = String(row.session);
				const stored: unknown = JSON.parse(String(row.value));
				if (!valid.check(stored)) throw new Error(`subagents.sqlite: the children of ${session} are not valid`);
				const env = envs.get(session) ?? null;
				const placed = stored.map(
					({ cwd, ...child }): Child =>
						cwd === undefined || child.location !== undefined ? child : { ...child, location: { cwd, env } },
				);
				return { session: Session({ id: session }), children: placed };
			});
		return { children };
	} finally {
		db.close();
	}
}

/**
 * Each session's environment in the catalog of the server store in `serverDir` (`migrate-catalog.ts` moved it there
 * first), read-only; none when the store has no catalog.
 */
function sessionEnvs(serverDir: string): Map<string, string | null> {
	const path = hostStore(serverDir);
	if (!existsSync(path)) return new Map();
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const found = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='p2.catalog:sessions'").get();
		if (found === undefined) return new Map();
		// The catalog's key is the session's address key, `session|<id>`.
		return new Map(
			db
				.prepare('SELECT substr(session, 9) AS id, env FROM "p2.catalog:sessions"')
				.all()
				.map((row) => [String(row.id), row.env === null ? null : String(row.env)]),
		);
	} finally {
		db.close();
	}
}

/** A stored share mode. */
function mode(value: unknown): "view" | "full" {
	if (value === "view" || value === "full") return value;
	throw new Error(`shares.sqlite: unknown mode ${JSON.stringify(value)}`);
}

/** Whether `stored` holds exactly `rows` (each table compared as a set). */
function sameRows<T extends object>(stored: T, rows: T): boolean {
	const sorted = (list: unknown) => (Array.isArray(list) ? list.map((row) => JSON.stringify(row)).sort() : list);
	return Object.entries(rows).every(([name, list]) =>
		isDeepStrictEqual(sorted(Object.getOwnPropertyDescriptor(stored, name)?.value), sorted(list)),
	);
}

/** Moves `file` with its journal files into the backup directory. */
function backup(dataDir: string, file: string): void {
	for (const suffix of JOURNAL) {
		const from = join(dataDir, `${file}${suffix}`);
		if (!existsSync(from)) continue;
		mkdirSync(join(dataDir, BACKUP), { recursive: true, mode: 0o700 });
		renameSync(from, join(dataDir, BACKUP, `${file}${suffix}`));
	}
}

/** Copies the SQLite file `from` with its journal files to `to` (offline: nothing writes them meanwhile). */
function copySqlite(from: string, to: string): void {
	mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
	for (const suffix of JOURNAL) if (existsSync(`${from}${suffix}`)) copyFileSync(`${from}${suffix}`, `${to}${suffix}`);
}
