// One store's uploads to the backup remote, used by the server (its own store) and each session's worker (the
// session's): Chord's `uploadSession` from the store's outbox, run by a `FlushScheduler` soon after each commit (about
// 200 ms after an urgent one: the worker's `isUrgentCommit`), with the last sequence the backup holds kept beside the store, and,
// for a target with accounts (Radius), the account the store's backup belongs to (the first one it was uploaded as).
import { createHash } from "node:crypto";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT, type Context } from "@p2/app/v1";
import {
	type BackupTarget,
	FileSyncStateStore,
	FlushScheduler,
	type SessionSyncUploader,
	type Store,
	type SyncFileSystem,
	type UploadResult,
	uploadSession,
} from "@p2/app/v1/node";
import type { BackupStatus } from "./contract.ts";

/**
 * The target's own folder for upload bookmarks (`backup/<key>/` beside each store): a store's "uploaded through N" is
 * true for one target only, so switching targets (a folder, then Radius) starts the new one from a full copy instead of
 * resuming another's history. Computed from the environment, so the server and every worker agree.
 */
export function backupTargetKey(target: BackupTarget): string {
	return target.kind === "named"
		? target.name
		: `folder-${createHash("sha256").update(target.path).digest("hex").slice(0, 12)}`;
}

/** The file system a store's uploader keeps its state with (`BackupUploaderOptions.files`). */
export const backupFiles = (dataDir: string): SyncFileSystem => new NodeExecutionEnv({ cwd: dataDir });

/** A failure's message, for statuses and the log. */
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What `BackupUploader` is given: the store, where it uploads to and as whom, and where it reports. */
export type BackupUploaderOptions = {
	/** The store to upload; opened with an outbox. */
	readonly store: Store;
	/** The remote's name of the store (`server`, `session-<id>`). */
	readonly name: string;
	/** This instance (the device of the slots it creates). */
	readonly device: string;
	/** Where the store's slots are created: only `putBatch` (an upload never reads the remote). */
	readonly remote: SessionSyncUploader;
	/**
	 * The store's host directory: the last sequence the backup holds is kept in `backup/<target>/` beside its store
	 * (`backupTargetKey`).
	 */
	readonly directory: string;
	/** The target's bookmark folder name (`backupTargetKey`). */
	readonly target: string;
	readonly files: SyncFileSystem;
	/**
	 * The account the target writes as now (`OpenBackupTarget.account`): the store is uploaded only as the account of its
	 * first upload. Null for a target without accounts (a folder): the store is uploaded whoever is signed in.
	 */
	readonly account: (context: Context) => Promise<string | null>;
	/** Where the backup stands, after each upload or failure. */
	readonly report: (status: BackupStatus) => void;
	/**
	 * Whether a failed upload will not pass by retrying (`OpenBackupTarget.terminal`): uploads stop until the instance
	 * restarts; the commits stay in the outbox. Other failures are retried with backoff.
	 */
	readonly terminal?: (error: unknown) => boolean;
	/** Scheduler delays, for tests. */
	readonly intervalMs?: number;
	readonly urgentMs?: number;
};

/** One store's uploads. `committed` after each commit; `close` uploads once more and stops. */
export class BackupUploader {
	readonly #options: BackupUploaderOptions;
	readonly #scheduler: FlushScheduler;
	readonly #state: FileSyncStateStore;
	/** A terminal failure or a broken history stopped uploads: no flush runs again in this process. */
	#stopped = false;

	constructor(options: BackupUploaderOptions) {
		this.#options = options;
		this.#state = new FileSyncStateStore(options.files, join(options.directory, "backup", options.target));
		this.#scheduler = new FlushScheduler({
			flush: () => this.#flush(BACKGROUND_CONTEXT),
			setTimer: (callback, delayMs) => {
				const timer = setTimeout(callback, delayMs);
				timer.unref();
				return () => clearTimeout(timer);
			},
			now: Date.now,
			onError: (error) => {
				const message = errorText(error);
				if (options.terminal?.(error) === true) {
					this.#stopped = true;
					options.report({ state: "error", error: `${message} (stopped until a restart)`, at: Date.now() });
					return;
				}
				options.report({ state: "error", error: message, at: Date.now() });
			},
			...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
			...(options.urgentMs === undefined ? {} : { urgentMs: options.urgentMs }),
		});
		// Whatever the store holds that the backup does not (commits from before a restart), soon.
		this.#scheduler.notify(false);
	}

	/** The store committed; `urgent` for what should leave the machine soon (`isUrgentCommit`). */
	committed(urgent: boolean): void {
		this.#scheduler.notify(urgent);
	}

	/** Uploads what is left and stops; a failure rejects (the commits stay in the outbox for the next start). */
	close(): Promise<void> {
		return this.#scheduler.close();
	}

	async #flush(context: Context): Promise<void> {
		// Stopped: nothing is retried (the scheduler's backoff, or the next commit, would retry forever).
		if (this.#stopped) return;
		const { name, report } = this.#options;
		const account = await this.#options.account(context);
		if (account !== null) {
			const owner = await this.#owner(context);
			if (owner !== undefined && owner !== account) {
				// Another person signed in on this machine: their account never gets this store's backup, which stays with
				// its owner, its commits waiting in the outbox for the owner's next sign-in.
				report({ state: "other_account", ...this.#head(await this.#synced(context)), at: Date.now() });
				return;
			}
			if (owner === undefined) await this.#bind(account, context);
		}
		report({ state: "uploading", ...this.#head(await this.#synced(context)), at: Date.now() });
		let result = await this.#upload(context);
		if (result.type === "remote_empty") {
			// The backup was deleted on the remote, maybe while this instance was offline, so nothing cleared the bookmark:
			// start over, the whole store from the start.
			await this.#state.delete(name, context);
			result = await this.#upload(context);
		}
		const head = this.#head(await this.#synced(context));
		switch (result.type) {
			case "uploaded":
			case "idle":
				report({ state: "synced", ...head, at: Date.now() });
				return;
			// A remote emptied again within this flush: a remote that does not keep what it took.
			case "remote_empty":
			case "diverged":
				this.#stop("diverged", "the backup's history is not this store's", head);
				return;
			case "behind":
				this.#stop("behind", "the store lost commits the backup holds", head);
				return;
		}
	}

	#upload(context: Context): Promise<UploadResult> {
		const { store, name, device, remote } = this.#options;
		return uploadSession({ sessionId: name, device, source: store, store: remote, state: this.#state, context });
	}

	/**
	 * Stops uploads until a restart: retrying cannot fix the history (another machine wrote it, the remote refused a body
	 * for good, the store lost what it uploaded). The commits stay in the outbox.
	 */
	#stop(state: "diverged" | "behind", why: string, head: { syncedHead?: number }): void {
		this.#stopped = true;
		this.#options.report({ state, ...head, error: `${why} (stopped until a restart)`, at: Date.now() });
	}

	/** The account this store's backup belongs to: `<name>.account` beside its bookmark; undefined before its first upload. */
	async #owner(context: Context): Promise<string | undefined> {
		const read = await this.#options.files.readTextFile(this.#accountFile, context);
		if (read.ok) return read.value;
		// The file system's answer (a trust boundary): a missing file is a store never uploaded, anything else fails.
		if ((read.error as { readonly code?: unknown }).code === "not_found") return undefined;
		throw read.error;
	}

	/** Writes the account file whole or not at all: a torn name would keep the store from uploading for good. */
	async #bind(account: string, context: Context): Promise<void> {
		const { files, directory, target } = this.#options;
		const created = await files.createDir(join(directory, "backup", target), { recursive: true }, context);
		if (!created.ok) throw created.error;
		const temporary = `${this.#accountFile}.tmp`;
		const written = await files.writeFile(temporary, account, context);
		if (!written.ok) throw written.error;
		const renamed = await files.renameFile(temporary, this.#accountFile, context);
		if (!renamed.ok) throw renamed.error;
	}

	get #accountFile(): string {
		const { directory, target, name } = this.#options;
		return join(directory, "backup", target, `${name}.account`);
	}

	async #synced(context: Context): Promise<number | undefined> {
		return (await this.#state.get(this.#options.name, context))?.syncedHead;
	}

	#head(syncedHead: number | undefined): { syncedHead?: number } {
		return syncedHead === undefined ? {} : { syncedHead };
	}
}
