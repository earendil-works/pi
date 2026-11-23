// The server's uploads of stores' slots to the backup remote, for the server's own store and every session's worker
// (`BackupUploads`): a slot's body handed to the remote as its chunks arrive (`StreamedUpload`), each upload under an id
// only its own store reaches.
import { randomUUID } from "node:crypto";
import { type Context, invalid, PluginError } from "@p2/app/v1";
import type { PutBatchResult, SessionSyncStore, SyncBody } from "@p2/app/v1/node";
import { BACKUP_TERMINAL, type BackupUploads } from "./contract.ts";
import { errorText } from "./uploader.ts";

/**
 * The slot uploads of the open backup: `remote` the backup's, `device` this instance's. Each upload's remote call runs
 * under `context` (the backup's own, not a caller's: it outlives the call that began it).
 */
export function openUploads(
	remote: SessionSyncStore,
	device: string,
	context: Context,
	terminal: ((error: unknown) => boolean) | undefined,
): BackupUploads & { close(): void } {
	const uploads = new Map<string, StreamedUpload>();
	/** The upload `id` of `store`: a store never reaches another store's. */
	const of = (store: string, id: string): StreamedUpload => {
		const found = uploads.get(id);
		if (found === undefined || found.store !== store) throw invalid("args", "backup: no such upload");
		return found;
	};
	return {
		begin: async (store, { after, to, archive }) => {
			const started = new StreamedUpload(store, (body) =>
				remote
					.putBatch(store, after, to, device, body, context, archive === true ? { archive } : {})
					.catch((error: unknown) => {
						// The worker stops on it too: its own uploader retries anything else.
						if (terminal?.(error) === true) throw new PluginError(BACKUP_TERMINAL, errorText(error));
						throw error;
					}),
			);
			await started.ready;
			// Answered without the body (the slot is taken, the history ends elsewhere), or failed before asking for it.
			if (started.answered) return { kind: "result", result: await started.result };
			const id = randomUUID();
			uploads.set(id, started);
			started.watch(() => {
				started.abort();
				uploads.delete(id);
			});
			return { kind: "upload", upload: id };
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

/** An upload whose worker sends nothing for this long is dropped (its body was abandoned). */
const UPLOAD_IDLE_MS = 60_000;

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
