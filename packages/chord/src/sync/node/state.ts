// Sync state in a local directory (Node).

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../../context/index.ts";
import type { SyncState, SyncStateStore } from "../client.ts";
import type { Seq } from "../remote.ts";
import { checkSessionId, isNotFound, writeAtomically } from "./remote.ts";

/**
 * Sync state in a directory, one JSON file per session, replaced through a temporary file and a rename. Losing the
 * directory loses nothing that matters: a copy without commits of its own takes the remote's head, and one with
 * commits finds out by uploading.
 */
export class FileSyncStateStore implements SyncStateStore {
	readonly #directory: string;

	constructor(directory: string) {
		this.#directory = directory;
	}

	async get(sessionId: string, _context: Context): Promise<SyncState | undefined> {
		let text: string;
		try {
			text = await readFile(this.#path(sessionId), "utf8");
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw error;
		}
		const stored = JSON.parse(text) as { syncedHead?: Seq; pulling?: Seq };
		return {
			syncedHead: stored.syncedHead,
			...(stored.pulling === undefined ? {} : { pulling: stored.pulling }),
		};
	}

	async set(sessionId: string, state: SyncState, _context: Context): Promise<void> {
		await writeAtomically(this.#directory, `${checkSessionId(sessionId)}.json`, JSON.stringify(state));
	}

	/** Forget a session, as when its copy is renamed or deleted. */
	async delete(sessionId: string, _context: Context): Promise<void> {
		await rm(this.#path(sessionId), { force: true });
	}

	#path(sessionId: string): string {
		return join(this.#directory, `${checkSessionId(sessionId)}.json`);
	}
}
