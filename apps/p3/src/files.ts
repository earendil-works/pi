// The base's files: which Pi a command line names, its data directory and kept port (`pi.json`), and private files
// and stores. A data directory and its stores are made private at every open (directories 0700, files 0600), since
// they hold the sign-ins and the sockets (`local-socket.ts`); the modes protect on POSIX only.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { type ChordStore, openStore, sqliteBackend } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { checkSocketPaths } from "./local-socket.ts";

/** Which Pi a command line names: `--pi <name>`, `--dir <path>`, or neither (the default Pi). */
export type PiChoice = { readonly pi?: string; readonly dir?: string };

/** The default Pi's name. */
export const DEFAULT_PI = "default";

/** The default Pi's port (p2 keeps 8788). Every other Pi takes a free one at its first start and keeps it. */
export const DEFAULT_PORT = 8789;

/** Whether `name` can name a Pi: lower case letters, digits, `-` and `_`, at most 32. */
export function isPiName(name: string): boolean {
	return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name);
}

/** The data directory of the Pi `choice` names. */
export function dataDirOf(choice: PiChoice): string {
	return choice.dir !== undefined ? resolve(choice.dir) : join(pisRoot(), choice.pi ?? DEFAULT_PI);
}

/** The Pis of `~/.pi/p3/`: every directory there with a Pi's name, by name. */
export async function pis(): Promise<{ readonly name: string; readonly dataDir: string }[]> {
	const root = pisRoot();
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	return entries
		.filter((entry) => entry.isDirectory() && isPiName(entry.name))
		.map((entry) => ({ name: entry.name, dataDir: join(root, entry.name) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The port the Pi on the real path `dataDir` keeps: its `pi.json`'s, else 8789 for the default Pi and 0 (a free one)
 * for others. The default Pi is known by its real path: a home reached through a link is still the home.
 */
export async function keptPort(dataDir: string): Promise<{ readonly port: number; readonly kept: boolean }> {
	const port = (await readConfig(dataDir))?.port;
	if (port !== undefined) return { port, kept: true };
	const defaultDir = await realpath(dataDirOf({})).catch(() => dataDirOf({}));
	return { port: dataDir === defaultDir ? DEFAULT_PORT : 0, kept: false };
}

/** Keeps `port` as the Pi's port (`pi.json`). */
export async function keepPort(dataDir: string, port: number): Promise<void> {
	await writePrivate(configFile(dataDir), JSON.stringify({ port }, null, "\t"));
}

/** Makes the Pi's config when it has none yet: an empty one (a start with `--port` keeps no port). */
export async function keepConfig(dataDir: string): Promise<void> {
	if ((await readConfig(dataDir)) === undefined) await writePrivate(configFile(dataDir), "{}");
}

/** The Pi's config, or `undefined` before its first start. */
export async function readConfig(dataDir: string): Promise<{ readonly port?: number } | undefined> {
	const text = await readFile(configFile(dataDir), "utf8").catch(() => undefined);
	if (text === undefined) return undefined;
	// A trust boundary: a file people edit.
	const { port } = JSON.parse(text) as { readonly port?: unknown };
	if (port !== undefined && !(typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535)) {
		throw new Error(`${configFile(dataDir)}: "port" must be a port number`);
	}
	return port === undefined ? {} : { port };
}

/** The Pi's config file. */
function configFile(dataDir: string): string {
	return join(dataDir, "pi.json");
}

/** Where the Pis live. */
function pisRoot(): string {
	return join(homedir(), ".pi", "p3");
}

/**
 * The real path of the data directory `path`, made private (0700) and made when missing; refused when it is the home
 * directory, a file system's root, another user's, in a parent directory other users may change (`checkParent`: the
 * immediate parent only), or too long a path for its sockets.
 */
export async function openDataDir(path: string): Promise<string> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const dataDir = await realpath(path);
	await checkDataDir(dataDir);
	await chmod(dataDir, 0o700);
	return dataDir;
}

/**
 * The real path of the existing data directory `path`, or `undefined` when there is none, for a command that asks its
 * sockets (`stop`, `status`): refused as `openDataDir` refuses, and when it is not private, since then others could
 * have made the sockets that would answer.
 */
export async function existingDataDir(path: string): Promise<string | undefined> {
	const dataDir = await realpath(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (dataDir === undefined) return undefined;
	const { mode } = await checkDataDir(dataDir);
	if ((mode & 0o077) !== 0) {
		const shown = (mode & 0o777).toString(8);
		throw new Error(
			`p3: the data directory ${dataDir} is not private (mode ${shown}; p3 makes it 0700 at every start)`,
		);
	}
	return dataDir;
}

/** Throws unless the real path `dataDir` can be a data directory (see `openDataDir`); its stats. */
async function checkDataDir(dataDir: string): Promise<{ readonly mode: number }> {
	const home = await realpath(homedir());
	if (dataDir === home || dataDir === parse(dataDir).root) {
		throw new Error(`p3: the data directory ${dataDir} must be a directory of p3's own`);
	}
	const { uid, mode } = await stat(dataDir);
	// POSIX: `p3` refuses Windows (`bin.ts`).
	const own = process.getuid!();
	if (uid !== own) throw new Error(`p3: the data directory ${dataDir} belongs to another user (uid ${uid})`);
	await checkParent(dataDir, own);
	checkSocketPaths(dataDir);
	return { mode };
}

/**
 * Throws when the immediate parent of the data directory `dataDir` is another user's (not root's), or every user may
 * write to it without the sticky bit: another user could rename the data directory away after its checks and put one of
 * theirs in its place. Only that parent is checked: an ancestor further up that others may change, or a parent its
 * group may write to (most systems give each user a group of their own, not all), is not refused (ERNDL-1059).
 */
async function checkParent(dataDir: string, own: number): Promise<void> {
	const parent = dirname(dataDir);
	const { uid, mode } = await stat(parent);
	const othersWrite = (mode & 0o002) !== 0 && (mode & 0o1000) === 0;
	if ((uid === own || uid === 0) && !othersWrite) return;
	throw new Error(`p3: the data directory ${dataDir} is in ${parent}, which other users may change; choose another`);
}

/** Makes `dir` (and missing parents) with mode 0700, and sets 0700 on it when it existed. */
export async function privateDirectory(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
}

/**
 * Opens the store file `path` of the server or a session's worker, private: created empty with mode 0600 when missing
 * (SQLite gives its journal files the database's mode), else set to 0600 with the journal files it has.
 */
export async function openPrivateStore(path: string, context: Context): Promise<ChordStore> {
	await (await open(path, "a", 0o600)).close();
	for (const file of [path, `${path}-wal`, `${path}-shm`]) {
		await chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
	return openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
}

/** Writes `text` to `path` with mode 0600 in one step: a temporary file of the same directory, synced, renamed. */
export async function writePrivate(path: string, text: string): Promise<void> {
	const temporary = join(dirname(path), `.${randomBytes(9).toString("base64url")}.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(text);
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temporary, path).catch(async (error: unknown) => {
		await rm(temporary, { force: true });
		throw error;
	});
}
