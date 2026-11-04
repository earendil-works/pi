// Chunked uploads of one `Files` object (slice 13 §4, design §23 "Chunked transfers"): each upload one file handle in
// the run's directory, written at positions. An append is accepted at the offset the accepted appends reached, so a
// writer may send several without waiting (the call window allows it): each write lands at its own position whatever
// order the thread pool completes them in. `uploaded`, `finish` and expiry wait for an upload's writes in flight; a
// failed write ends its upload.

import type { FileHandle } from "node:fs/promises";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ChordError } from "../../data/index.ts";
import { invalid } from "../../data/internal.ts";
import { newToken } from "./secrets.ts";

/** An upload under way: its file, the bytes accepted, its writes in flight, its first failed write, its end. */
type Upload = {
	readonly name: string;
	readonly mime: string;
	readonly handle: FileHandle;
	size: number;
	touched: number;
	readonly writes: Set<Promise<unknown>>;
	failed: boolean;
	ended: Promise<void> | undefined;
};

/** A finished upload: its name, type and size, its bytes moved to the path `finish` was given. */
export type Finished = { readonly name: string; readonly mime: string; readonly size: number };

/**
 * The uploads under way of one `Files` object, in the directory `run` (this object's own, made on first use), at most
 * `max` at once: each holds a file handle until it ends, so a caller beginning uploads without end would exhaust the
 * process's descriptors.
 */
export class Uploads {
	readonly #run: string;
	readonly #max: number;
	readonly #uploads = new Map<string, Upload>();

	constructor(run: string, max: number) {
		this.#run = run;
		this.#max = max;
	}

	/** The bytes accepted by every upload under way (they count against the host's cap). */
	get size(): number {
		let size = 0;
		for (const upload of this.#uploads.values()) size += upload.size;
		return size;
	}

	/** A new upload of `name` and `mime`: its id; `unavailable` (`busy`) while `max` are under way. */
	async begin(name: string, mime: string): Promise<string> {
		if (this.#uploads.size >= this.#max) {
			throw new ChordError({
				code: "unavailable",
				reason: "busy",
				message: `files: ${this.#max} uploads are under way; finish one, or wait for an idle one to expire`,
			});
		}
		const id = newToken(12);
		await mkdir(this.#run, { recursive: true, mode: 0o700 });
		const handle = await open(join(this.#run, id), "wx", 0o600);
		const upload: Upload = {
			name,
			mime,
			handle,
			size: 0,
			touched: Date.now(),
			writes: new Set(),
			failed: false,
			ended: undefined,
		};
		this.#uploads.set(id, upload);
		return id;
	}

	/**
	 * Writes `bytes` at `offset` of upload `id`, which must be where the accepted appends reached (else `invalid`, its
	 * details the expected `{ offset }`); `room(adding, fileSize)` refuses what the caps do not allow, before anything
	 * is accepted. A failed write ends the upload.
	 */
	async append(
		id: string,
		offset: number,
		bytes: Uint8Array,
		room: (adding: number, fileSize: number) => void,
	): Promise<void> {
		const upload = this.#underway(id);
		if (offset !== upload.size) {
			throw invalid("args", `files: upload ${id} is at offset ${upload.size}, not ${offset}`, {
				offset: upload.size,
			});
		}
		room(bytes.length, upload.size + bytes.length);
		// Accepted now, with no await before the write starts: the next append may follow at once, its write going to
		// its own position.
		upload.size += bytes.length;
		upload.touched = Date.now();
		const write = upload.handle.write(bytes, 0, bytes.length, offset);
		upload.writes.add(write);
		try {
			await write;
		} catch (error) {
			upload.writes.delete(write);
			if (!upload.failed) {
				upload.failed = true;
				this.#uploads.delete(id);
				await this.#end(upload);
				await rm(join(this.#run, id), { force: true });
			}
			throw error;
		}
		upload.writes.delete(write);
	}

	/** The bytes of upload `id` written so far, once its writes in flight landed: where a writer resumes. */
	async uploaded(id: string): Promise<number> {
		const upload = this.#underway(id);
		await Promise.allSettled([...upload.writes]);
		if (upload.failed) throw failedUpload(id);
		return upload.size;
	}

	/** Ends upload `id` once its writes landed and moves its file to `path`; refused when a write of it failed. */
	async finish(id: string, path: string): Promise<Finished> {
		const upload = this.#underway(id);
		// Taken out first: an append arriving now finds no upload.
		this.#uploads.delete(id);
		await this.#end(upload);
		if (upload.failed) throw failedUpload(id);
		await rename(join(this.#run, id), path);
		return { name: upload.name, mime: upload.mime, size: upload.size };
	}

	/** Drops the uploads unwritten for `idleMs`, once their writes landed. */
	async expire(idleMs: number): Promise<void> {
		const now = Date.now();
		for (const [id, upload] of this.#uploads) {
			if (now - upload.touched >= idleMs) await this.#discard(id, upload);
		}
	}

	/** Drops every upload under way (their object ended). */
	async close(): Promise<void> {
		for (const [id, upload] of this.#uploads) await this.#discard(id, upload);
	}

	/** The upload `id` under way; else `invalid`. */
	#underway(id: string): Upload {
		const upload = this.#uploads.get(id);
		if (upload === undefined) throw invalid("args", `files: no upload ${id} (finished, failed, expired or unknown)`);
		return upload;
	}

	/** Takes upload `id` out, closes its file once its writes landed and removes it. */
	async #discard(id: string, upload: Upload): Promise<void> {
		this.#uploads.delete(id);
		await this.#end(upload);
		await rm(join(this.#run, id), { force: true });
	}

	/** Closes `upload`'s file once its writes in flight landed; once, whoever ends it first. */
	#end(upload: Upload): Promise<void> {
		upload.ended ??= Promise.allSettled([...upload.writes]).then(() => upload.handle.close());
		return upload.ended;
	}
}

/** The refusal of an upload one of whose writes failed. */
function failedUpload(id: string): Error {
	return invalid("args", `files: upload ${id} failed to write and was dropped`);
}
