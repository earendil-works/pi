// The directories of p2's hosts, laid out as the app kit lays out its hosts (Chord's `node/app/layout.ts`): the
// server's `<data>/server/` and each session's `<data>/sessions/<id>/`, each with its Chord store (`store.sqlite`, mode
// 0600 with its journal files) and its files (`files/`, the kit's `Files`), directories mode 0700. Nothing here assumes
// two host kinds: projects become a third directory of the same shape.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store, sqliteBackend } from "@earendil-works/chord";
import { privateDirectory, privateStore } from "@earendil-works/chord/app/files";
import type { Context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";

/** A session id as a directory name: the catalog's UUIDs (anything else would name another directory). */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The server's directory. */
export function serverDirectory(dataDir: string): string {
	return join(dataDir, "server");
}

/** The directory of session `id`; refused for an id that is no plain name. */
export function sessionDirectory(dataDir: string, id: string): string {
	if (!SESSION_ID.test(id)) throw new Error(`Invalid session id ${JSON.stringify(id)}`);
	return join(dataDir, "sessions", id);
}

/** A host directory's store file. */
export function hostStore(dir: string): string {
	return join(dir, "store.sqlite");
}

/** A host directory's files directory (the kit's `Files`). */
export function hostFiles(dir: string): string {
	return join(dir, "files");
}

/**
 * Opens the store of the host directory `dir`, made private first, with its outbox on or off (`openStore`'s option:
 * stored, so passing it turns an existing store's outbox off too). p2 keeps every outbox off until it syncs.
 */
export async function openHostStore(
	dir: string,
	options: { readonly outbox: boolean },
	context: Context,
): Promise<Store> {
	await privateDirectory(dir);
	await privateStore(hostStore(dir));
	return openStore(sqliteBackend(await openNodeSqliteDatabase(hostStore(dir))), context, options);
}

/**
 * Refuses a data directory still in the layout before per-host stores (`server.sqlite`, `sessions/<id>.sqlite`): the
 * server would start on empty stores beside them. `npm run migrate-data` moves them.
 */
export function assertMigrated(dataDir: string): void {
	const sessions = join(dataDir, "sessions");
	const old =
		existsSync(join(dataDir, "server.sqlite")) ||
		(existsSync(sessions) && readdirSync(sessions).some((name) => name.endsWith(".sqlite")));
	if (old)
		throw new Error(
			`${dataDir} holds data in p2's old layout (server.sqlite, sessions/<id>.sqlite): stop p2 and run \`npm run migrate-data\``,
		);
}
