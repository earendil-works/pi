// A Pi is its data directory. Which one a command means: the default Pi (`~/.pi/p3`), a named one
// (`~/.pi/p3/pis/<name>`) or any directory; the port each keeps (`pi.json`, from its first start); and the named Pis.

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultDataDir, writePrivate } from "./files.ts";

/** Which Pi a command line names: `--pi <name>`, `--dir <path>`, or neither (the default Pi). */
export type PiChoice = { readonly pi?: string; readonly dir?: string };

/** The default Pi's port (p2 keeps 8788). Every other Pi takes a free one at its first start and keeps it. */
export const DEFAULT_PORT = 8789;

/** Whether `name` can name a Pi: lower case letters, digits, `-` and `_`, at most 32. */
export function isPiName(name: string): boolean {
	return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name);
}

/** The data directory of the Pi `choice` names. */
export function dataDirOf(choice: PiChoice): string {
	if (choice.dir !== undefined) return resolve(choice.dir);
	return choice.pi === undefined ? defaultDataDir() : join(pisRoot(), choice.pi);
}

/** The port the Pi on `dataDir` keeps: its `pi.json`'s, else 8789 for the default Pi and 0 (a free one) for others. */
export async function keptPort(dataDir: string): Promise<{ readonly port: number; readonly kept: boolean }> {
	const port = (await readConfig(dataDir))?.port;
	if (port !== undefined) return { port, kept: true };
	return { port: resolve(dataDir) === defaultDataDir() ? DEFAULT_PORT : 0, kept: false };
}

/** Keeps `port` as the Pi's port (`pi.json`). */
export async function keepPort(dataDir: string, port: number): Promise<void> {
	await writePrivate(configFile(dataDir), JSON.stringify({ port }, null, "\t"));
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

/** The named Pis: every directory under `~/.pi/p3/pis/`, by name. */
export async function namedPis(): Promise<{ readonly name: string; readonly dataDir: string }[]> {
	const root = pisRoot();
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	return entries
		.filter((entry) => entry.isDirectory() && isPiName(entry.name))
		.map((entry) => ({ name: entry.name, dataDir: join(root, entry.name) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The Pi's config file. */
function configFile(dataDir: string): string {
	return join(dataDir, "pi.json");
}

/** Where the named Pis live. */
function pisRoot(): string {
	return join(defaultDataDir(), "pis");
}
