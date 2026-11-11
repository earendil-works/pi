// A session's worker uploads its store through the server's `BackupRemote`: a slot's body sent in chunks of at most
// `CHUNK_BYTES` (Chord carries bytes only as whole method arguments), streamed on to the remote as they arrive. A worker
// only uploads its own store, which the server names from the worker's principal.
import type { Context, Ctx, RefIn } from "@p2/app/v1";
import type { PutBatchResult, SessionSyncUploader, SyncBody } from "@p2/app/v1/node";
import { type BackupRemote, CHUNK_BYTES } from "./contract.ts";

/** Runs `fn` with the server's `BackupRemote`, as the worker (a root of the worker's own under `context`). */
export type WithRemote = <T>(
	fn: (remote: RefIn<typeof BackupRemote, "worker">, ctx: Ctx) => Promise<T>,
	context: Context,
) => Promise<T>;

/** A worker's uploads of its own store, named `name` (the uploader passes it as the session ID). */
export class ChunkedRemote implements SessionSyncUploader {
	readonly #name: string;
	readonly #with: WithRemote;

	constructor(name: string, withRemote: WithRemote) {
		this.#name = name;
		this.#with = withRemote;
	}

	putBatch(
		sessionId: string,
		after: number,
		to: number,
		_device: string,
		body: SyncBody,
		context: Context,
		options: { readonly archive?: boolean } = {},
	): Promise<PutBatchResult> {
		this.#own(sessionId);
		return this.#with(async (remote, ctx) => {
			const begun = await remote.begin({ after, to, ...(options.archive === true ? { archive: true } : {}) }, ctx);
			if ("result" in begun) return begun.result;
			const { upload } = begun;
			try {
				for await (const chunk of chunks(body)) await remote.append({ upload, bytes: chunk }, ctx);
			} catch (error) {
				// The body could not be read or sent: the server drops what it has; the upload is retried from the start.
				await remote.abort({ upload }, ctx);
				throw error;
			}
			return remote.finish({ upload }, ctx);
		}, context);
	}

	#own(sessionId: string): void {
		if (sessionId !== this.#name) throw new Error(`A worker uploads only its own store, not ${sessionId}`);
	}
}

/** `body` as chunks of at most `CHUNK_BYTES`, read as they are sent. */
async function* chunks(body: SyncBody): AsyncGenerator<Uint8Array> {
	let pending: Uint8Array[] = [];
	let size = 0;
	for await (const part of body) {
		let at = 0;
		while (at < part.length) {
			const take = Math.min(part.length - at, CHUNK_BYTES - size);
			pending.push(part.subarray(at, at + take));
			size += take;
			at += take;
			if (size === CHUNK_BYTES) {
				yield joined(pending, size);
				pending = [];
				size = 0;
			}
		}
	}
	if (size > 0) yield joined(pending, size);
}

function joined(parts: readonly Uint8Array[], size: number): Uint8Array {
	if (parts.length === 1 && parts[0]!.length === size) return parts[0]!;
	const out = new Uint8Array(size);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}
