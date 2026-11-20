// The base's files: the data directory and the stores made private (directories 0700, files 0600, also when they
// existed looser: other local users must not read a store's sign-ins, nor replace it), and private files written in
// one step.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";

/** The default Pi's data directory: `~/.pi/p3`. */
export function defaultDataDir(): string {
	return join(homedir(), ".pi", "p3");
}

/**
 * The real path of the data directory `path`, made private (0700) and made when missing; refused when it is the home
 * directory, a file system's root, or another user's.
 */
export async function openDataDir(path: string): Promise<string> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const dataDir = await realpath(path);
	const home = await realpath(homedir());
	if (dataDir === home || dataDir === parse(dataDir).root) {
		throw new Error(`p3: the data directory ${dataDir} must be a directory of p3's own`);
	}
	const { uid } = await stat(dataDir);
	if (process.getuid !== undefined && uid !== process.getuid()) {
		throw new Error(`p3: the data directory ${dataDir} belongs to another user (uid ${uid})`);
	}
	await chmod(dataDir, 0o700);
	return dataDir;
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
