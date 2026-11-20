// A Pi's own config, `pi.json` in its data directory: its id (random, made at its first start: what tells this Pi from
// another on the same machine, for instance in the name of its sign-in cookie) and the port it listens on (kept from
// its first start, so its address stays the same).

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ifExists } from "./layout.ts";
import { writeSecret } from "./secrets.ts";

/** A Pi's config: its id, and its port once it listened on one of its own. */
export type PiConfig = { readonly id: string; readonly port?: number };

/** The config in the file `path`, made with a fresh id when the file is missing. */
export async function openConfig(path: string): Promise<PiConfig> {
	const existing = await readConfig(path);
	if (existing !== undefined) return existing;
	const config = { id: randomBytes(8).toString("hex") };
	await writeConfig(path, config);
	return config;
}

/** The config in the file `path`; `undefined` when the Pi never started. */
export async function readConfig(path: string): Promise<PiConfig | undefined> {
	const text = await ifExists(readFile(path, "utf8"));
	if (text === undefined) return undefined;
	// A trust boundary: a file people edit. The id becomes part of a cookie's name.
	const { id, port } = JSON.parse(text) as { readonly id?: unknown; readonly port?: unknown };
	if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) throw new Error(`${path}: "id" must be 16 hex digits`);
	if (port === undefined) return { id };
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`${path}: "port" must be a port number`);
	}
	return { id, port };
}

/** Writes `config` to the file `path`, in one step. */
export async function writeConfig(path: string, config: PiConfig): Promise<void> {
	await writeSecret(path, JSON.stringify(config, null, "\t"), "replace");
}
