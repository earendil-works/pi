// A watcher of one folder under the Pi's skills root and everything under it (`FolderWatch`): it says when anything
// there changed, also once a folder that does not exist yet is made (its nearest existing ancestor is watched until
// then), and it never watches a folder whose real path leaves the root's (a link out). Every look at the disk is
// asynchronous: a change seen while waiting for the folder costs the server's loop no blocking call.

import { type FSWatcher, watch } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, sep } from "node:path";

/**
 * A watcher of one folder at a time under `root` (which exists: the set makes it before it watches): `changed` is
 * called after each change, and once whenever it starts watching a folder. An error (the folder removed) re-arms it.
 * Arming is queued: each `watch` is applied in order, the last one wins.
 */
export class FolderWatch {
	readonly #root: string;
	readonly #changed: () => void;
	#path: string | undefined;
	#watched: string | undefined;
	#waiting = false;
	#watcher: FSWatcher | undefined;
	#arming: Promise<void> = Promise.resolve();

	/** A watcher under `root` that watches nothing yet; each change calls `changed`. */
	constructor(root: string, changed: () => void) {
		this.#root = root;
		this.#changed = changed;
	}

	/** Watches `path` (a folder under the root) instead of the folder before; `undefined`: nothing. */
	watch(path: string | undefined): void {
		this.#path = path;
		this.#rearm();
	}

	/** Stops watching, at once: no change is reported after it (an arm still under way finds itself outdated). */
	close(): void {
		this.#path = undefined;
		this.#watcher?.close();
		this.#watcher = undefined;
		this.#watched = undefined;
	}

	/** Queues an arm: one at a time, so a slow look at the disk never lands after a later one. */
	#rearm(): void {
		this.#arming = this.#arming.then(() => this.#arm());
	}

	/** Watches the folder `watchable` names for `#path`, if it is another than now. */
	async #arm(): Promise<void> {
		const path = this.#path;
		const found = path === undefined ? undefined : await watchable(this.#root, path);
		const target = found?.real;
		// A newer `watch` or `close` came meanwhile: its own arm, queued behind this one, decides.
		if (path !== this.#path) return;
		this.#waiting = found?.at !== path;
		if (target === this.#watched) return;
		this.#watcher?.close();
		this.#watcher = undefined;
		this.#watched = target;
		if (target === undefined) return;
		try {
			this.#watcher = watch(target, { recursive: true }, () => {
				// Waiting for the folder: it may exist now.
				if (this.#waiting) this.#rearm();
				this.#changed();
			});
			this.#watcher.on("error", () => {
				this.#watched = undefined;
				this.#rearm();
				this.#changed();
			});
			// Armed after the folder was looked at: what changed meanwhile (a folder renamed into place) had no watcher to
			// see it, so a new watcher reports once (Astra, review of the cleanup).
			this.#changed();
		} catch {
			// Gone between the look and the watch: nothing is watched until the next `watch`.
			this.#watched = undefined;
		}
	}
}

/** A folder to watch: the existing folder on the way to the wanted one (`at`), and its real path. */
export type Watchable = { readonly at: string; readonly real: string };

/**
 * The folder a watch of `path` (under `root`) watches now: `path` when it exists, else its nearest existing ancestor up
 * to the root; `undefined` when that folder's real path is not inside the root's (a link out), or the root is gone.
 */
export async function watchable(root: string, path: string): Promise<Watchable | undefined> {
	let at = path;
	while (at !== root && !(await isFolder(at))) at = dirname(at);
	// People's files (a trust boundary): a folder that vanished while looking is no folder.
	const [realRoot, real] = await Promise.all([
		realpath(root).catch(() => undefined),
		realpath(at).catch(() => undefined),
	]);
	if (realRoot === undefined || real === undefined) return undefined;
	return real === realRoot || real.startsWith(realRoot + sep) ? { at, real } : undefined;
}

/** Whether `path` is a folder now (a link to one counts: `watchable` checks where it leads). */
async function isFolder(path: string): Promise<boolean> {
	return (await stat(path).catch(() => undefined))?.isDirectory() === true;
}
