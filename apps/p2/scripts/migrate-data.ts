// Moves a p2 data directory to per-host stores (brief "per-host stores", Part D), offline:
//
//   npm run migrate-data -- [--dry-run] [--data <dir>]
//
// It refuses while a server holds the data directory's process lock, and holds it meanwhile. The server's Chord store
// moves from `server.sqlite` to `server/store.sqlite`; each session's Durable records move from `sessions/<id>.sqlite`
// into its store `sessions/<id>/store.sqlite` (`migrate-durable.ts`), its artifacts, uploads and download snapshots
// into its `Files` (`migrate-files.ts`). A session is built in `sessions/.<id>.migrating/`, from a copy of its old
// store, verified (every record read back through Durable's `Storage` from both and compared; every file byte for
// byte), then renamed into place; only then do its old files move to `pre-files-backup/` (same relative paths).
// Uploads stay where they are as well: `uploads/<session>/` is where this machine's attachments are materialized now,
// and old transcripts name those paths. Nothing is deleted. A crash redoes the session it was in; a finished session is
// skipped; running it again is harmless. `--dry-run` builds and verifies every session in a temporary directory and
// changes nothing. The summary goes to stdout as JSON; the exit code is 1 when a session failed.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { encodeJsonl, openStore, sqliteBackend } from "@earendil-works/chord";
import { filesFacet } from "@earendil-works/chord/app/files";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type Ctx, createHost, type Ref } from "../src/runtime/chord.ts";
import { hostFiles, hostStore, openHostStore, serverDirectory, sessionDirectory } from "../src/runtime/host-dirs.ts";
import { HOST } from "../src/runtime/principals.ts";
import { takeProcessLock } from "../src/runtime/process-lock.ts";
import { Files } from "../src/runtime/session-files.ts";
import { durableStorage } from "../src/runtime/session-store.ts";
import { convertDurable, type DurableCounts, verifyDurable } from "./migrate-durable.ts";
import { type FileCounts, migrateFiles, verifyFiles } from "./migrate-files.ts";

/** What a migration did. */
export type MigrationSummary = {
	readonly dataDir: string;
	readonly dryRun: boolean;
	/** The server's store: moved now, moved before, or there was none. */
	readonly server: "migrated" | "done" | "absent";
	readonly sessions: {
		readonly migrated: readonly string[];
		/** Finished by an earlier run. */
		readonly skipped: readonly string[];
		readonly failed: readonly { readonly id: string; readonly error: string }[];
	};
	readonly entries: number;
	readonly documents: number;
	readonly files: number;
	readonly bytes: number;
};

/** A SQLite file and its journal files. */
const JOURNAL = ["", "-wal", "-shm"];

/** Migrates the data directory `dataDir` (see the header); `dryRun` changes nothing. */
export async function migrateData(options: {
	readonly dataDir: string;
	readonly dryRun: boolean;
}): Promise<MigrationSummary> {
	const { dataDir, dryRun } = options;
	// The server's lock is named after the data directory as it was given; a resolved spelling is held too.
	const names = [...new Set([`p2:server:${dataDir}`, `p2:server:${resolve(dataDir)}`])];
	const unlocks: (() => Promise<void>)[] = [];
	try {
		for (const name of names) {
			unlocks.push(
				await takeProcessLock(name, 1000).catch(() => {
					throw new Error(`A p2 server runs on ${dataDir}: stop it first`);
				}),
			);
		}
		const work = dryRun ? mkdtempSync(join(tmpdir(), "p2-migrate-dry-run-")) : dataDir;
		try {
			const server = await migrateServer(dataDir, work, dryRun);
			const summary = {
				migrated: [] as string[],
				skipped: [] as string[],
				failed: [] as { id: string; error: string }[],
			};
			let entries = 0;
			let documents = 0;
			let files = 0;
			let bytes = 0;
			for (const id of sessionsOf(dataDir)) {
				try {
					const result = await migrateSession(dataDir, work, id, dryRun);
					if (result === "done") {
						summary.skipped.push(id);
						continue;
					}
					summary.migrated.push(id);
					entries += result.durable.entries;
					documents += result.durable.documents;
					files += result.files.artifacts + result.files.uploads + result.files.downloads;
					bytes += result.files.bytes;
				} catch (error) {
					summary.failed.push({ id, error: error instanceof Error ? error.message : String(error) });
				}
			}
			return { dataDir, dryRun, server, sessions: summary, entries, documents, files, bytes };
		} finally {
			if (dryRun) rmSync(work, { recursive: true, force: true });
		}
	} finally {
		for (const unlock of unlocks.reverse()) await unlock();
	}
}

/** The ids of the sessions still in the old layout (`sessions/<id>.sqlite`), or already moved with backups to finish. */
function sessionsOf(dataDir: string): string[] {
	const sessions = join(dataDir, "sessions");
	if (!existsSync(sessions)) return [];
	return readdirSync(sessions)
		.filter((name) => name.endsWith(".sqlite") && !name.startsWith("."))
		.map((name) => name.slice(0, -".sqlite".length))
		.sort();
}

/**
 * Moves `server.sqlite` to `server/store.sqlite` (into `work`'s for a dry run): copied with its journal, verified (the
 * copy's export equals the old store's, each read from a scratch copy), then the old files go to the backup.
 */
async function migrateServer(dataDir: string, work: string, dryRun: boolean): Promise<MigrationSummary["server"]> {
	const old = join(dataDir, "server.sqlite");
	const target = hostStore(serverDirectory(work));
	if (!existsSync(old)) return existsSync(hostStore(serverDirectory(dataDir))) ? "done" : "absent";
	if (!dryRun && existsSync(target)) {
		backup(dataDir, ["server.sqlite"]);
		return "done";
	}
	const scratch = mkdtempSync(join(tmpdir(), "p2-migrate-server-"));
	try {
		copySqlite(old, join(scratch, "old.sqlite"));
		const expected = await exported(join(scratch, "old.sqlite"));
		const staging = join(serverDirectory(work), ".store-migrating");
		rmSync(staging, { recursive: true, force: true });
		mkdirSync(staging, { recursive: true, mode: 0o700 });
		copySqlite(old, hostStore(staging));
		const store = await openHostStore(staging, { outbox: false }, context);
		await store.close(context);
		if ((await exported(hostStore(staging))) !== expected) throw new Error("server.sqlite differs after the copy");
		for (const suffix of JOURNAL)
			if (existsSync(`${hostStore(staging)}${suffix}`))
				renameSync(`${hostStore(staging)}${suffix}`, `${target}${suffix}`);
		rmSync(staging, { recursive: true, force: true });
		if (!dryRun) backup(dataDir, ["server.sqlite"]);
		return "migrated";
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Migrates session `id` (into `work`'s `sessions/` for a dry run): a finished one (its directory there, its old store
 * gone) is `done`; one renamed into place whose backup did not finish gets its backup.
 */
async function migrateSession(
	dataDir: string,
	work: string,
	id: string,
	dryRun: boolean,
): Promise<"done" | { readonly durable: DurableCounts; readonly files: FileCounts }> {
	const old = join(dataDir, "sessions", `${id}.sqlite`);
	const target = sessionDirectory(work, id);
	if (!dryRun && existsSync(target)) {
		// Renamed into place after it verified: only its backup is left.
		backupSession(dataDir, id);
		return "done";
	}
	const staging = dryRun ? target : join(dataDir, "sessions", `.${id}.migrating`);
	// What a crash left of an earlier attempt is built again.
	rmSync(staging, { recursive: true, force: true });
	const scratch = join(staging, ".old");
	mkdirSync(scratch, { recursive: true, mode: 0o700 });
	const copy = join(scratch, "old.sqlite");
	copySqlite(old, copy);
	// Written with the outbox off; turned on below, from the store's head: the replay is no history to sync.
	const store = await openHostStore(staging, { outbox: false }, context);
	let durable: DurableCounts;
	let seqs: Awaited<ReturnType<typeof convertDurable>>["seqs"];
	let files: FileCounts;
	try {
		const storage = await durableStorage(store, context);
		({ seqs, counts: durable } = await convertDurable(copy, storage, store, context));
		await storage.close(context);
		files = await withFiles(store, staging, (ref, ctx) => migrateFiles(dataDir, id, ref, ctx));
	} finally {
		await store.close(context);
	}
	// Verified on the store as reopened: what was written is what is stored.
	const reopened = await openHostStore(staging, { outbox: false }, context);
	try {
		const before = await openNodeSqliteStorage(copy);
		const after = await durableStorage(reopened, context);
		try {
			await verifyDurable(before, after, copy, seqs, context);
		} finally {
			await after.close(context);
			await before.close(context);
		}
		await withFiles(reopened, staging, (ref, ctx) => verifyFiles(dataDir, id, ref, ctx));
	} finally {
		await reopened.close(context);
	}
	rmSync(scratch, { recursive: true, force: true });
	if (!dryRun) {
		renameSync(staging, target);
		backupSession(dataDir, id);
	}
	return { durable, files };
}

/** Runs `fn` with the `Files` of the host directory `dir` on `store` (a host of its own, closed after). */
async function withFiles<T>(
	store: Awaited<ReturnType<typeof openHostStore>>,
	dir: string,
	fn: (files: Ref<typeof Files>, ctx: Ctx) => Promise<T>,
): Promise<T> {
	const errors: unknown[] = [];
	const host = createHost({ principal: HOST, store, onError: (error) => errors.push(error) });
	try {
		await host.load([{ name: "chord.app.files", facet: filesFacet(hostFiles(dir)) }], context);
		return await host.root(async (ctx) => fn(await ctx.get(Files, {}), ctx), context);
	} finally {
		await host.close(context);
	}
}

/** Moves session `id`'s old store, artifacts and download snapshots into the backup (uploads stay: see the header). */
function backupSession(dataDir: string, id: string): void {
	backup(dataDir, [join("sessions", `${id}.sqlite`), join("artifacts", id), join("downloads", id)]);
}

/** Moves each of `paths` (relative to `dataDir`, a SQLite file with its journal files) into `pre-files-backup/`. */
function backup(dataDir: string, paths: readonly string[]): void {
	for (const path of paths) {
		for (const suffix of path.endsWith(".sqlite") ? JOURNAL : [""]) {
			const from = join(dataDir, `${path}${suffix}`);
			if (!existsSync(from)) continue;
			const to = join(dataDir, "pre-files-backup", `${path}${suffix}`);
			mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
			renameSync(from, to);
		}
	}
}

/** Copies the SQLite file `from` with its journal files to `to` (offline: nothing writes them meanwhile). */
function copySqlite(from: string, to: string): void {
	for (const suffix of JOURNAL) if (existsSync(`${from}${suffix}`)) copyFileSync(`${from}${suffix}`, `${to}${suffix}`);
}

/** The JSONL export of the Chord store file `path`. */
async function exported(path: string): Promise<string> {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
	try {
		const chunks: Uint8Array[] = [];
		for await (const chunk of encodeJsonl(store.export(context))) chunks.push(chunk);
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		await store.close(context);
	}
}

async function main(args: readonly string[]): Promise<void> {
	const option = (name: string) => {
		const index = args.indexOf(name);
		return index === -1 ? undefined : args[index + 1];
	};
	// As the server finds it.
	const dataDir = option("--data") ?? process.env.P2_DATA_DIR ?? join(homedir(), ".pi", "p2");
	const summary = await migrateData({ dataDir, dryRun: args.includes("--dry-run") });
	console.log(JSON.stringify(summary, null, "\t"));
	if (summary.sessions.failed.length) process.exitCode = 1;
}

if (import.meta.main) await main(process.argv.slice(2));
