// Environment helpers (Node) for plugins that work on this device or an SSH environment (envs, files, prompt,
// locations): path rules of a remote system, results as exceptions, this device's folders and an environment
// configuration's revision.
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, type PlatformPath, posix, win32 } from "node:path";
import type { FileError, Result } from "@earendil-works/pi-durable/env";
import type { Connection } from "@earendil-works/pi-env";
import { normalizePath } from "./config-json.ts";
import type { DirectoryListing } from "./schemas.ts";

/** Node's path rules of the remote system. */
export async function remotePaths(connection: Connection): Promise<PlatformPath> {
	return (await connection.info()).os === "windows" ? win32 : posix;
}

/** The value of a result, or its error as an exception with the environment's message. */
export function value<T>(result: Result<T, FileError>): T {
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

/** Folders of `path` on this device (`~` expands), as `EnvManager.listDirectory` lists a remote one. */
export async function listLocalDirectory(path: string): Promise<DirectoryListing> {
	const absolute = normalizePath(path);
	const entries = await readdir(absolute, { withFileTypes: true });
	const directories = (
		await Promise.all(
			entries.slice(0, 10000).map(async (entry) => {
				const path = join(absolute, entry.name);
				return entry.isDirectory() ||
					(entry.isSymbolicLink() && (await stat(path).catch(() => undefined))?.isDirectory())
					? path
					: undefined;
			}),
		)
	)
		.filter((entry) => entry !== undefined)
		.sort((a, b) => a.localeCompare(b));
	return {
		path: absolute,
		parent: dirname(absolute) === absolute ? null : dirname(absolute),
		directories: directories.slice(0, 1000),
		truncated: entries.length > 10000 || directories.length > 1000,
	};
}

/** Changes whenever the configuration of an env changes; part of its id, so workers notice edits. */
export function envRevision(config: Readonly<Record<string, unknown>>): string {
	const canonical = (value: unknown): unknown =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(
					Object.entries(value)
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						.map(([key, field]) => [key, canonical(field)]),
				)
			: value;
	return createHash("sha256")
		.update(JSON.stringify(canonical(config)))
		.digest("hex")
		.slice(0, 12);
}
