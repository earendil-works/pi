import type { Context } from "@earendil-works/chord/context";
import type { FileError, FileSystem, Result } from "../env/index.ts";
import type { Seq } from "../types.ts";
import type { SyncState, SyncStateStore } from "./client.ts";
import { checkSessionId } from "./filesystem.ts";

function unwrap<T>(result: Result<T, FileError>): T {
	if (!result.ok) throw result.error;
	return result.value;
}

/**
 * Sync state in a directory, one JSON file per session, replaced through a temporary file and a rename. Losing the
 * directory loses nothing that matters: a copy without commits of its own takes the remote's head, and one with
 * commits finds out by uploading.
 */
export class FileSyncStateStore implements SyncStateStore {
	readonly #fs: FileSystem;
	readonly #directory: string;

	constructor(fs: FileSystem, directory: string) {
		this.#fs = fs;
		this.#directory = directory;
	}

	async get(sessionId: string, context: Context): Promise<SyncState | undefined> {
		const result = await this.#fs.readTextFile(await this.#path(sessionId, ".json", context), context);
		if (!result.ok && result.error.code === "not_found") return undefined;
		const stored = JSON.parse(unwrap(result)) as { syncedHead?: Seq; pulling?: Seq };
		return {
			syncedHead: stored.syncedHead,
			...(stored.pulling === undefined ? {} : { pulling: stored.pulling }),
		};
	}

	async set(sessionId: string, state: SyncState, context: Context): Promise<void> {
		unwrap(await this.#fs.createDir(this.#directory, { recursive: true }, context));
		const path = await this.#path(sessionId, ".json", context);
		const temporary = await this.#path(sessionId, ".json.tmp", context);
		unwrap(await this.#fs.writeFile(temporary, JSON.stringify(state), context));
		unwrap(await this.#fs.renameFile(temporary, path, context));
	}

	/** Forget a session, as when its copy is renamed or deleted. */
	async delete(sessionId: string, context: Context): Promise<void> {
		unwrap(await this.#fs.remove(await this.#path(sessionId, ".json", context), { force: true }, context));
	}

	async #path(sessionId: string, suffix: string, context: Context): Promise<string> {
		return unwrap(await this.#fs.joinPath([this.#directory, `${checkSessionId(sessionId)}${suffix}`], context));
	}
}
