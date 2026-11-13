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
import { createSqliteTelemetry, type SqliteTelemetry } from "@earendil-works/chord/telemetry-sqlite";

/** A session id as a directory name: the catalog's UUIDs (anything else would name another directory). */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The server's directory. */
export function serverDirectory(dataDir: string): string {
	return join(dataDir, "server");
}

/**
 * The user plugin root, `<data>/plugins/`: plugins the owner or an agent writes (docs/agent-plugins.md), loaded after the
 * built-ins (a built-in wins a name), kept across p2 updates, never in the checkout.
 */
export function userPluginsDirectory(dataDir: string): string {
	return join(dataDir, "plugins");
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
	/** `outbox` turns the outbox on or off; omitted, the stored setting stays (never pass false to keep it off). */
	options: { readonly outbox?: boolean },
	context: Context,
): Promise<Store> {
	await privateDirectory(dir);
	await privateStore(hostStore(dir));
	return openStore(sqliteBackend(await openNodeSqliteDatabase(hostStore(dir))), context, options);
}

/**
 * The server's telemetry store (`<data>/telemetry.sqlite`, mode 0600): its own file, not the server's Chord store (high
 * volume, 7 days, never in the outbox or a backup; Chord's decision "The server is the one place telemetry is stored").
 */
export function telemetryStore(dataDir: string): string {
	return join(dataDir, "telemetry.sqlite");
}

/**
 * Opens the server's telemetry store with Chord's defaults (7 days, a queue of 10,000 spans, a flush every second):
 * the server records to it and is its only writer (pages and workers send theirs over their links). `close` drains it.
 */
export async function openTelemetry(
	dataDir: string,
): Promise<{ readonly telemetry: SqliteTelemetry; close(): Promise<void> }> {
	await privateStore(telemetryStore(dataDir));
	const db = await openNodeSqliteDatabase(telemetryStore(dataDir));
	const telemetry = await createSqliteTelemetry(db).catch(async (error: unknown) => {
		await db.close();
		throw error;
	});
	return {
		telemetry,
		close: async () => {
			await telemetry.close();
			await db.close();
		},
	};
}

/**
 * Refuses a data directory still in a layout before the current one: before per-host stores (`server.sqlite`,
 * `sessions/<id>.sqlite`), or with server data still in plain SQLite (`catalog.sqlite`, `shares.sqlite`,
 * `subagents.sqlite`). The server would start on an empty
 * store beside them. `npm run migrate-data` moves them.
 */
export function assertMigrated(dataDir: string): void {
	const sessions = join(dataDir, "sessions");
	const old =
		existsSync(join(dataDir, "server.sqlite")) ||
		["catalog.sqlite", "shares.sqlite", "subagents.sqlite"].some((file) => existsSync(join(dataDir, file))) ||
		(existsSync(sessions) && readdirSync(sessions).some((name) => name.endsWith(".sqlite")));
	if (old)
		throw new Error(
			`${dataDir} holds data in p2's old layout (server.sqlite, catalog.sqlite, shares.sqlite, subagents.sqlite or sessions/<id>.sqlite): stop p2 and run \`npm run migrate-data\``,
		);
}
