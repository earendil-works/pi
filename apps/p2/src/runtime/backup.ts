// Backing up this instance's Chord stores (the server's and every session's) to a backup remote, so that a lost machine
// loses nothing it uploaded. Each store's owner uploads it (one writer per store): the server its own store, each
// session's worker the session's. Only the server holds the remote; workers upload through it (`BackupRemote`).
//
// A store keeps an outbox only while backup is configured: the server and each worker open their store with
// `outbox: backupConfigured(dataDir)`. Offline tools open stores without the option, keeping what is stored (an
// outbox turned off drops its commits, which would lose what was not uploaded yet).
import { join } from "node:path";
import type { Store } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
	FileSyncStateStore,
	FileSystemSyncRemote,
	FlushScheduler,
	type PutBatchResult,
	type SessionSyncStore,
	type SessionSyncUploader,
	type SyncBody,
	type SyncFileSystem,
	uploadSession,
} from "@earendil-works/chord/sync";
import type { CommitPublication } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { INPUT_ENTRY } from "./input.ts";

export type { PutBatchResult, SessionSyncStore, SessionSyncUploader, SyncBody };

/** Where this instance backs up to: a folder (a local disk, a mounted bucket or NAS; tests). */
export type BackupTarget = { readonly kind: "folder"; readonly path: string };

/** The backup target from the environment (`P2_BACKUP_DIR`), or undefined when backup is off. */
export function backupTarget(env: NodeJS.ProcessEnv = process.env): BackupTarget | undefined {
	const path = env.P2_BACKUP_DIR;
	return path ? { kind: "folder", path } : undefined;
}

/** Whether stores keep an outbox: backup is configured. Read where stores open (server, worker). */
export function backupConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return backupTarget(env) !== undefined;
}

/** The remote's name of the server's store. */
export const SERVER_STORE = "server";

/** The remote's name of a session's store. */
export const sessionStoreName = (session: string): string => `session-${session}`;

/** Entries that should leave the machine soon: what a person sent (p2's input, Durable's user entry) and an answer. */
const URGENT_ENTRIES: ReadonlySet<string> = new Set([INPUT_ENTRY, "pi.user", "pi.assistant"]);

/**
 * Whether a session commit should be uploaded soon (about 200 ms) rather than with the next ordinary flush (5 s): what
 * the user sent, a finished answer, a settled submission. A host that may be stopped any time (a Durable Object evicted
 * after idling) then loses at most the last moments of a turn, never a whole exchange.
 */
export function isUrgentCommit(publication: CommitPublication): boolean {
	return publication.changes.some(
		(change) =>
			(change.type === "entry" && URGENT_ENTRIES.has(change.value.kind)) ||
			(change.type === "submission" && (change.value.status === "done" || change.value.status === "unanswered")),
	);
}

/** Where one store's backup stands (`plugins/backup`'s `BackupStatus`). */
export type StoreBackupStatus = {
	readonly state: "synced" | "uploading" | "error" | "behind" | "diverged";
	readonly syncedHead?: number;
	readonly error?: string;
	readonly at: number;
};

/** The remote of `target`, its paths resolved from `dataDir`, and the file system its uploads keep their state with. */
export function openBackupRemote(
	target: BackupTarget,
	dataDir: string,
): { readonly remote: SessionSyncStore; readonly files: SyncFileSystem } {
	const files = new NodeExecutionEnv({ cwd: dataDir });
	return { remote: new FileSystemSyncRemote(files, target.path), files };
}

/** The file system a store's uploader keeps its state with (`BackupUploaderOptions.files`). */
export const backupFiles = (dataDir: string): SyncFileSystem => new NodeExecutionEnv({ cwd: dataDir });

export type BackupUploaderOptions = {
	/** The store to upload; opened with an outbox. */
	readonly store: Store;
	/** The remote's name of the store (`server`, `session-<id>`). */
	readonly name: string;
	/** This instance (the device of the slots it creates). */
	readonly device: string;
	/** Where the store's slots are created: only `putBatch` (an upload never reads the remote). */
	readonly remote: SessionSyncUploader;
	/** The store's host directory: the last sequence the backup holds is kept in `backup/` beside its store. */
	readonly directory: string;
	readonly files: SyncFileSystem;
	/** Where the backup stands, after each upload or failure. */
	readonly report: (status: StoreBackupStatus) => void;
	/** Scheduler delays, for tests. */
	readonly intervalMs?: number;
	readonly urgentMs?: number;
};

/** One store's uploads. `committed` after each commit; `close` uploads once more and stops. */
export class BackupUploader {
	readonly #options: BackupUploaderOptions;
	readonly #scheduler: FlushScheduler;
	readonly #state: FileSyncStateStore;

	constructor(options: BackupUploaderOptions) {
		this.#options = options;
		this.#state = new FileSyncStateStore(options.files, join(options.directory, "backup"));
		this.#scheduler = new FlushScheduler({
			flush: () => this.#flush(BACKGROUND_CONTEXT),
			setTimer: (callback, delayMs) => {
				const timer = setTimeout(callback, delayMs);
				timer.unref();
				return () => clearTimeout(timer);
			},
			now: Date.now,
			onError: (error) =>
				options.report({
					state: "error",
					error: error instanceof Error ? error.message : String(error),
					at: Date.now(),
				}),
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
		const { store, name, device, remote, report } = this.#options;
		report({ state: "uploading", ...this.#head(await this.#synced(context)), at: Date.now() });
		const result = await uploadSession({
			sessionId: name,
			device,
			source: store,
			store: remote,
			state: this.#state,
			context,
		});
		const head = this.#head(await this.#synced(context));
		switch (result.type) {
			case "uploaded":
			case "idle":
				report({ state: "synced", ...head, at: Date.now() });
				return;
			case "behind":
				report({ state: "behind", ...head, at: Date.now() });
				return;
			case "diverged":
			case "stale_epoch":
				report({ state: "diverged", ...head, at: Date.now() });
				return;
		}
	}

	async #synced(context: Context): Promise<number | undefined> {
		return (await this.#state.get(this.#options.name, context))?.syncedHead;
	}

	#head(syncedHead: number | undefined): { syncedHead?: number } {
		return syncedHead === undefined ? {} : { syncedHead };
	}
}
