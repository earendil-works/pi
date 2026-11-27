// A file or folder of people's opened only where it is confined: never through a link at its last part, and verified
// inside a given real folder by the opened object's own real path, so a link anywhere on the way out of that folder
// is refused at the open. What `folder.ts` reads of a set is opened through it.

import { constants, type FileHandle, open, readlink, realpath } from "node:fs/promises";
import { sep } from "node:path";

/** An open file or folder verified inside a folder: its handle, its real path, and where to reach it. */
export type Confined = { readonly handle: FileHandle; readonly real: string; readonly at: string };

/**
 * `path` opened as a regular file or a folder, its last part never a link (`O_NOFOLLOW`), then verified where it was
 * opened: the opened object's real path (Linux and Android name it in `/proc/self/fd`) is `within` (a real path) or
 * inside it. `at` reaches the verified object itself (its `/proc/self/fd` path) where the system names one; elsewhere
 * the real path is looked up after the open, a window someone with a shell on the Pi could use (accepted as for
 * Files). `undefined` for anything else: missing, a link, outside, another kind of file. The caller closes `handle`.
 */
export async function openConfined(
	within: string | undefined,
	path: string,
	kind: "file" | "folder",
): Promise<Confined | undefined> {
	if (within === undefined) return undefined;
	const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (kind === "folder" ? constants.O_DIRECTORY : 0);
	// People's files (a trust boundary): any failure to open is "not there".
	const handle = await open(path, flags).catch(() => undefined);
	if (handle === undefined) return undefined;
	const proc = `/proc/self/fd/${handle.fd}`;
	const named = await readlink(proc).catch(() => undefined);
	const real = named ?? (await realpath(path).catch(() => undefined));
	const stats = await handle.stat().catch(() => undefined);
	const fits = kind === "file" ? stats?.isFile() : stats?.isDirectory();
	if (real === undefined || fits !== true || !(real === within || real.startsWith(within + sep))) {
		await handle.close();
		return undefined;
	}
	return { handle, real, at: named === undefined ? real : proc };
}
