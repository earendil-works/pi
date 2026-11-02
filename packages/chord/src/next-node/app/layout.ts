// The app kit's data directory (slice 13 §4, decision "The app kit, point 4: storage"): one fixed layout, made private
// at every start. `server/` holds the server's store and files, `workers/<kind>/<address>/` each worker's store and
// files, `plugins/` the user's plugins root, `logs/` the logs, `owner-token` the owner's token for command-line
// clients. Directories are 0700 and stores 0600, also when they existed looser before (other local users must not
// read the sessions in a store, nor replace it).

import { createHash } from "node:crypto";
import { chmod, mkdir, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse } from "node:path";
import type { Address } from "../../next/contracts/index.ts";

/** The paths of a data directory. */
export type AppLayout = {
	readonly dataDir: string;
	readonly server: string;
	readonly serverStore: string;
	readonly workers: string;
	readonly plugins: string;
	readonly logs: string;
	readonly ownerToken: string;
	readonly cookieSecret: string;
};

/** The data directory of app `name` unless the start script names one: `~/.<name>`. */
export function defaultDataDir(name: string): string {
	return join(homedir(), `.${name}`);
}

/**
 * The real path of the data directory `path`, made when missing (mode 0700), refused when the kit must not make it
 * private: the home directory, a file system's root, or a directory another user owns (a clear error, instead of
 * tightening a directory others use or failing on `EPERM`). Its mode is set on the real path, never through a link.
 */
export async function openDataDir(path: string): Promise<string> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const dataDir = await realpath(path);
	const home = await realpath(homedir());
	if (dataDir === home || dataDir === parse(dataDir).root) {
		const what = dataDir === home ? "the home directory" : "a file system's root";
		throw new Error(`startApp: the data directory ${dataDir} is ${what}; name a directory of the app's own`);
	}
	const { uid } = await stat(dataDir);
	if (process.getuid !== undefined && uid !== process.getuid()) {
		throw new Error(`startApp: the data directory ${dataDir} belongs to another user (uid ${uid})`);
	}
	return dataDir;
}

/** The layout of `dataDir` (a real path, `openDataDir`'s), its directories made private (`privateDirectory`). */
export async function createLayout(dataDir: string): Promise<AppLayout> {
	await privateDirectory(dataDir);
	const layout: AppLayout = {
		dataDir,
		server: join(dataDir, "server"),
		serverStore: join(dataDir, "server", "store.sqlite"),
		workers: join(dataDir, "workers"),
		plugins: join(dataDir, "plugins"),
		logs: join(dataDir, "logs"),
		ownerToken: join(dataDir, "owner-token"),
		cookieSecret: join(dataDir, "server", "cookie-secret"),
	};
	for (const dir of [layout.server, layout.workers, layout.plugins, layout.logs]) await privateDirectory(dir);
	return layout;
}

/** Makes `dir` (and missing parents) with mode 0700, and sets 0700 on it when it existed. */
export async function privateDirectory(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
}

/**
 * Makes the store file `path` private before SQLite opens it: created empty with mode 0600 when missing (SQLite gives
 * its journal files the database's mode), else set to 0600 with the journal files it has.
 */
export async function privateStore(path: string): Promise<void> {
	await (await open(path, "a", 0o600)).close();
	for (const file of [path, `${path}-wal`, `${path}-shm`]) {
		await chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

/** The directory of the worker at `address`: `workers/<kind>/<its key, encoded>`. */
export function workerDirectory(dataDir: string, address: Address): string {
	return join(dataDir, "workers", address.kind, encodedKey(address.key));
}

/** The longest key kept readable as a directory name; a longer one is named by its hash. */
const READABLE_KEY = 160;

/**
 * An address key as one directory name: percent-encoded (`/`, `\`, `.` and every other character a file system might
 * treat specially included), or its SHA-256 when that is longer than `READABLE_KEY`. Capital letters are encoded too:
 * on a case-insensitive file system (macOS) `p|A` and `p|a` would otherwise share a directory.
 */
function encodedKey(key: string): string {
	const encoded = encodeURIComponent(key).replace(
		/(%[0-9A-F]{2})|[.!'()*~A-Z]/g,
		(match, escaped: string | undefined) => escaped ?? `%${match.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return encoded.length <= READABLE_KEY ? encoded : `sha256-${createHash("sha256").update(key).digest("hex")}`;
}
