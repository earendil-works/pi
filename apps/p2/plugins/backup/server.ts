// The server's backup (`src/runtime/backup.ts`): holds the backup remote, uploads the server's own store, gives each
// session's worker the remote for its own store (`BackupRemote`: slot bodies streamed through here in chunks), and
// keeps every store's last reported status. Inert while backup is not configured (`P2_BACKUP_DIR`).
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type Context, defineFacet, forbidden, isWorker, nativeOf, serveNative, withoutAbortSignal } from "@p2/app/v1";
import {
	BackupUploader,
	backupTarget,
	LockedFile,
	openBackupRemote,
	type PutBatchResult,
	processLogs,
	SERVER_STORE,
	type SessionSyncStore,
	type SyncBody,
	serverDirectory,
	sessionStoreName,
} from "@p2/app/v1/node";
import { Server, serverOf } from "@p2/app/v1/server";
import { Backup, BackupNative, BackupRemote, type BackupStatus, type BackupUploads } from "./contract.ts";

/** An upload whose worker sends nothing for this long is dropped (its body was abandoned). */
const UPLOAD_IDLE_MS = 60_000;

/** This instance's device ID: `device.json` in the data directory, as logins keep it (made on first use). */
async function deviceId(dataDir: string): Promise<string> {
	const file = new LockedFile(join(dataDir, "device.json"));
	try {
		return await file.withLockAsync(async (content) => {
			const data: unknown = JSON.parse(content ?? "{}");
			if (typeof data === "object" && data !== null && "id" in data && typeof data.id === "string" && data.id)
				return { result: data.id };
			const id = randomUUID();
			return { result: id, next: JSON.stringify({ ...(typeof data === "object" ? data : {}), id }) };
		});
	} finally {
		await file.close();
	}
}

/**
 * A slot's body handed to the remote as its chunks arrive. `begin` starts the remote's `putBatch` on `#body()` and
 * waits for `ready`: the remote asked for the body's first chunk, or answered without it (`answered`). `push` hands
 * over one chunk and resolves once the remote asks for the next one (it took this one) or answered; `end` closes the
 * body and resolves with the result; `abort` fails the body, so the remote drops what it read.
 */
export class StreamedUpload {
	readonly store: string;
	readonly result: Promise<PutBatchResult>;
	/** Resolves when the remote asks for the next chunk, or once it answered. */
	#asked = Promise.withResolvers<void>();
	/** The chunk the remote waits for, while it waits. */
	#waiting: PromiseWithResolvers<IteratorResult<Uint8Array>> | undefined;
	#answered = false;
	#aborted: Error | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#onIdle: (() => void) | undefined;
	#idleMs = UPLOAD_IDLE_MS;

	constructor(store: string, put: (body: SyncBody) => Promise<PutBatchResult>) {
		this.store = store;
		this.result = put(this.#body());
		const settled = (): void => {
			this.#answered = true;
			this.#stopIdle();
			this.#asked.resolve();
		};
		this.result.then(settled, settled);
	}

	/** The remote asked for the body, or answered without it. */
	get ready(): Promise<void> {
		return this.#asked.promise;
	}

	/** The remote answered (`result` settled), before or while reading the body. */
	get answered(): boolean {
		return this.#answered;
	}

	/** `onIdle` runs when no chunk arrives for `idleMs` (its worker is gone); each `push` restarts the wait. */
	watch(onIdle: () => void, idleMs = UPLOAD_IDLE_MS): void {
		this.#idleMs = idleMs;
		this.#onIdle = onIdle;
		this.#restartIdle();
	}

	async push(bytes: Uint8Array): Promise<void> {
		this.#restartIdle();
		await this.#asked.promise;
		const waiting = this.#waiting;
		if (this.#answered || waiting === undefined) return;
		this.#waiting = undefined;
		this.#asked = Promise.withResolvers<void>();
		waiting.resolve({ value: bytes, done: false });
		await this.#asked.promise;
	}

	async end(): Promise<PutBatchResult> {
		this.#stopIdle();
		await this.#asked.promise;
		const waiting = this.#waiting;
		this.#waiting = undefined;
		waiting?.resolve({ value: undefined, done: true });
		return this.result;
	}

	abort(): void {
		this.#stopIdle();
		this.#aborted = new Error("The upload was aborted");
		const waiting = this.#waiting;
		this.#waiting = undefined;
		waiting?.reject(this.#aborted);
	}

	async *#body(): SyncBody {
		for (;;) {
			if (this.#aborted !== undefined) throw this.#aborted;
			this.#waiting = Promise.withResolvers<IteratorResult<Uint8Array>>();
			const item = this.#waiting.promise;
			this.#asked.resolve();
			const next = await item;
			if (next.done) return;
			yield next.value;
		}
	}

	#restartIdle(): void {
		if (this.#onIdle === undefined || this.#answered) return;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(this.#onIdle, this.#idleMs);
		this.#timer.unref();
	}

	#stopIdle(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}

/**
 * The slot uploads of the open backup: `remote` the backup's, `device` this instance's. Each upload's remote call runs
 * under `context` (the backup's own, not a caller's: it outlives the call that began it).
 */
function openUploads(remote: SessionSyncStore, device: string, context: Context): BackupUploads & { close(): void } {
	const uploads = new Map<string, StreamedUpload>();
	/** The upload `id` of `store`: a store never reaches another store's. */
	const of = (store: string, id: string): StreamedUpload => {
		const found = uploads.get(id);
		if (found === undefined || found.store !== store) throw new Error("No such upload");
		return found;
	};
	return {
		begin: async (store, { after, to, archive }) => {
			const started = new StreamedUpload(store, (body) =>
				remote.putBatch(store, after, to, device, body, context, archive === true ? { archive } : {}),
			);
			await started.ready;
			// Answered without the body (the slot is taken, the history ends elsewhere), or failed before asking for it.
			if (started.answered) return { result: await started.result };
			const id = randomUUID();
			uploads.set(id, started);
			started.watch(() => {
				started.abort();
				uploads.delete(id);
			});
			return { upload: id };
		},
		append: (store, id, bytes) => of(store, id).push(bytes),
		finish: (store, id) => {
			const found = of(store, id);
			uploads.delete(id);
			return found.end();
		},
		abort: (store, id) => {
			const found = uploads.get(id);
			if (found?.store !== store) return;
			found.abort();
			uploads.delete(id);
		},
		close: () => {
			for (const upload of uploads.values()) upload.abort();
			uploads.clear();
		},
	};
}

export default defineFacet((host) => {
	serveNative(host, BackupNative);
	host.serve(Backup, (_params, self) => {
		const server = self.get(Server, {});
		const natives = serverOf(self);
		const statuses = self.writable<Record<string, BackupStatus>>({});
		const device = self.writable<string | null>(null);
		// Set while this object runs; the server store's last upload reports after it ended (its close), to the log only.
		let ended = false;
		const report = (store: string, status: BackupStatus): void => {
			if (!ended) statuses.set({ ...statuses.value, [store]: status });
			if (status.state === "error" || status.state === "behind" || status.state === "diverged")
				processLogs.append(`backup:${store}`, "event", `${status.state}${status.error ? `: ${status.error}` : ""}`);
		};
		// The remote, this instance's device, the uploads workers stream through it, and the server store's uploader (its
		// outbox is on while backup is configured: the server opens the store so).
		const backup = self.open(
			async (context) => {
				const target = backupTarget();
				const store = natives().store;
				if (target === undefined || store === undefined) return undefined;
				const { dataDir } = server.info.value;
				const { remote, files } = openBackupRemote(target, dataDir);
				const id = await deviceId(dataDir);
				device.set(id);
				const uploads = openUploads(remote, id, withoutAbortSignal(context));
				const uploader = new BackupUploader({
					store,
					name: SERVER_STORE,
					device: id,
					remote,
					directory: serverDirectory(dataDir),
					files,
					report: (status) => report(SERVER_STORE, status),
				});
				// The server's store is written by many objects: the store tells of every commit. Uploading writes nothing
				// to the store (its bookmark is a file, its outbox trim no commit), so this never wakes itself.
				const stopWatching = store.onCommitted(
					() => uploader.committed(false),
					(error) => processLogs.append("backup:server", "event", `following commits failed: ${text(error)}`),
				);
				processLogs.append("backup", "event", `Backing up to ${target.path} as device ${id}`);
				return { uploads, uploader, stopWatching };
			},
			async (opened) => {
				ended = true;
				if (opened === undefined) return;
				opened.stopWatching();
				opened.uploads.close();
				await opened.uploader.close().catch((error: unknown) => report(SERVER_STORE, failed(error)));
			},
		);
		self.contribute(BackupNative, {
			get uploads() {
				return backup.value?.uploads;
			},
		});
		return {
			device: self.derive([device], ([value]) => value),
			statuses: self.derive([statuses], ([value]) => value),
			report: async ({ store, status }) => {
				report(store, status);
				return null;
			},
		};
	});

	host.serve(BackupRemote, (_params, principal, self) => {
		// Only a session's own worker uploads, and only its own store: named from the principal, never from arguments.
		if (!isWorker(principal)) throw forbidden("the backup remote is for session workers");
		const store = sessionStoreName(principal.session);
		const backup = self.get(Backup, {});
		const native = nativeOf(self, BackupNative, "The backup");
		const uploads = (): BackupUploads => {
			const open = native().uploads;
			if (open === undefined) throw new Error("Backup is off");
			return open;
		};
		return {
			variant: "worker",
			members: {
				device: backup.device,
				report: ({ status }, ctx) => backup.report({ store, status }, ctx),
				begin: (slot) => uploads().begin(store, slot),
				append: async ({ upload, bytes }) => {
					await uploads().append(store, upload, bytes);
					return null;
				},
				finish: ({ upload }) => uploads().finish(store, upload),
				abort: async ({ upload }) => {
					uploads().abort(store, upload);
					return null;
				},
			},
		};
	});
});

const text = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const failed = (error: unknown): BackupStatus => ({ state: "error", error: text(error), at: Date.now() });
