// The server's backup (`src/runtime/backup.ts`): holds the backup remote, uploads the server's own store, gives each
// session's worker the remote for its own store (`BackupRemote`: slot bodies streamed through here in chunks), and
// keeps every store's last reported status. Inert while backup is not configured (`P2_BACKUP_DIR`).
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type Context, defineFacet, forbidden, isWorker, withoutAbortSignal } from "@p2/app/v1";
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
import { Backup, BackupRemote, type BackupStatus } from "./contract.ts";

/** How often the server's own store is checked for commits to upload (its writes come from many objects). */
const SERVER_POLL_MS = 1000;
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
 * A slot's body as a stream the remote reads while chunks arrive: `push` hands it the next chunk and resolves once
 * the remote took it; `end` closes it. The remote's `putBatch` runs alongside, started by `begin`.
 */
class StreamedUpload {
	readonly store: string;
	readonly result: Promise<PutBatchResult>;
	/** Set when the remote answered without reading the whole body (`exists`, `not_head`). */
	#answered = false;
	#next: PromiseWithResolvers<IteratorResult<Uint8Array>> | undefined;
	#taken: PromiseWithResolvers<void> | undefined;
	#ended = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	readonly #onIdle: () => void;

	constructor(store: string, put: (body: SyncBody) => Promise<PutBatchResult>, onIdle: () => void) {
		this.store = store;
		this.#onIdle = onIdle;
		this.result = put(this.#body());
		void this.result.then(
			() => {
				this.#answered = true;
				this.#taken?.resolve();
			},
			() => {
				this.#answered = true;
				this.#taken?.resolve();
			},
		);
		this.#touch();
	}

	/** The remote wants no body: it answered before reading any. */
	async answeredEarly(): Promise<PutBatchResult | undefined> {
		const later = new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined)));
		return Promise.race([this.result, later]);
	}

	async push(bytes: Uint8Array): Promise<void> {
		this.#touch();
		if (this.#answered || this.#ended) return;
		this.#taken = Promise.withResolvers<void>();
		await this.#waitForReader();
		this.#next?.resolve({ value: bytes, done: false });
		this.#next = undefined;
		await this.#taken.promise;
	}

	end(): Promise<PutBatchResult> {
		this.#ended = true;
		clearTimeout(this.#timer);
		this.#next?.resolve({ value: undefined, done: true });
		this.#next = undefined;
		return this.result;
	}

	abort(): void {
		this.#ended = true;
		clearTimeout(this.#timer);
		this.#next?.reject(new Error("The upload was aborted"));
		this.#next = undefined;
	}

	async #waitForReader(): Promise<void> {
		while (this.#next === undefined && !this.#answered) await new Promise((resolve) => setImmediate(resolve));
	}

	#touch(): void {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(this.#onIdle, UPLOAD_IDLE_MS);
		this.#timer.unref();
	}

	async *#body(): SyncBody {
		while (!this.#ended || this.#next !== undefined) {
			this.#next = Promise.withResolvers<IteratorResult<Uint8Array>>();
			// The previous chunk was consumed when the reader asks for the next one.
			this.#taken?.resolve();
			const item = await this.#next.promise;
			if (item.done) return;
			yield item.value;
		}
	}
}

export default defineFacet((host) => {
	host.serve(Backup, (_params, self) => {
		const server = self.get(Server, {});
		const natives = serverOf(self);
		const statuses = self.writable<Record<string, BackupStatus>>({});
		const device = self.writable<string | null>(null);
		const uploads = new Map<string, StreamedUpload>();
		// Set while this object runs; the server store's last upload reports after it ended (its close), to the log only.
		let ended = false;
		const report = (store: string, status: BackupStatus): void => {
			if (!ended) statuses.set({ ...statuses.value, [store]: status });
			if (status.state === "error" || status.state === "behind" || status.state === "diverged")
				processLogs.append(`backup:${store}`, "event", `${status.state}${status.error ? `: ${status.error}` : ""}`);
		};
		// The remote, this instance's device, and the server store's uploader (its outbox is on while backup is
		// configured: the server opens the store so).
		const backup = self.open(
			async () => {
				const target = backupTarget();
				const store = natives().store;
				if (target === undefined || store === undefined) return undefined;
				const { dataDir } = server.info.value;
				const { remote, files } = openBackupRemote(target, dataDir);
				const id = await deviceId(dataDir);
				device.set(id);
				const uploader = new BackupUploader({
					store,
					name: SERVER_STORE,
					device: id,
					remote,
					directory: serverDirectory(dataDir),
					files,
					report: (status) => report(SERVER_STORE, status),
				});
				// The server's store is written by many objects: its sequence is checked instead of each writer telling.
				let seen = store.lastSeq;
				const poll = setInterval(() => {
					if (store.lastSeq === seen) return;
					seen = store.lastSeq;
					uploader.committed(false);
				}, SERVER_POLL_MS);
				poll.unref();
				processLogs.append("backup", "event", `Backing up to ${target.path} as device ${id}`);
				return { remote, uploader, poll };
			},
			async (opened) => {
				ended = true;
				if (opened === undefined) return;
				clearInterval(opened.poll);
				for (const upload of uploads.values()) upload.abort();
				uploads.clear();
				await opened.uploader.close().catch((error: unknown) => report(SERVER_STORE, failed(error)));
			},
		);
		const remote = (): SessionSyncStore => {
			const opened = backup.value;
			if (opened === undefined) throw new Error("Backup is off");
			return opened.remote;
		};
		const upload = (store: string, id: string): StreamedUpload => {
			const found = uploads.get(id);
			if (found === undefined || found.store !== store) throw new Error("No such upload");
			return found;
		};
		return {
			device: self.derive([device], ([value]) => value),
			statuses: self.derive([statuses], ([value]) => value),
			report: async ({ store, status }) => {
				report(store, status);
				return null;
			},
			list: async ({ store }, ctx) => {
				const listing = await remote().list(store, ctx);
				return { batches: [...listing.batches], snapshots: [...listing.snapshots] };
			},
			begin: async ({ store, after, to, archive }, ctx) => {
				const id = device.value;
				if (id === null) throw new Error("Backup is off");
				// The remote reads the body as chunks arrive; the call outlives this method, so not its abort.
				const context: Context = withoutAbortSignal(ctx);
				const started = new StreamedUpload(
					store,
					(body) => remote().putBatch(store, after, to, id, body, context, archive === true ? { archive } : {}),
					() => {
						started.abort();
						uploads.delete(uploadId);
					},
				);
				const early = await started.answeredEarly();
				if (early !== undefined) return { result: early };
				const uploadId = randomUUID();
				uploads.set(uploadId, started);
				return { upload: uploadId };
			},
			append: async ({ store, upload: id, bytes }) => {
				await upload(store, id).push(bytes);
				return null;
			},
			finish: async ({ store, upload: id }) => {
				const found = upload(store, id);
				uploads.delete(id);
				return found.end();
			},
			abort: async ({ store, upload: id }) => {
				// Only the store's own upload: a worker never ends another store's.
				const found = uploads.get(id);
				if (found?.store === store) {
					found.abort();
					uploads.delete(id);
				}
				return null;
			},
		};
	});

	host.serve(BackupRemote, (_params, principal, self) => {
		// Only a session's own worker uploads, and only its own store: named from the principal, never from arguments.
		if (!isWorker(principal)) throw forbidden("the backup remote is for session workers");
		const store = sessionStoreName(principal.session);
		const backup = self.get(Backup, {});
		return {
			variant: "worker",
			members: {
				device: backup.device,
				report: ({ status }, ctx) => backup.report({ store, status }, ctx),
				list: (_args, ctx) => backup.list({ store }, ctx),
				begin: (args, ctx) => backup.begin({ store, ...args }, ctx),
				append: (args, ctx) => backup.append({ store, ...args }, ctx),
				finish: (args, ctx) => backup.finish({ store, ...args }, ctx),
				abort: (args, ctx) => backup.abort({ store, ...args }, ctx),
			},
		};
	});
});

const failed = (error: unknown): BackupStatus => ({
	state: "error",
	error: error instanceof Error ? error.message : String(error),
	at: Date.now(),
});
