// Files (slice 13 §4, decision "The app kit, point 5: plugins, files and export"): the kit's file storage, one `Files`
// object per host (`self.get(Files, {})`), its files in the host's directory (`files/`) and its index (id, name, mime,
// size, created) a watchable member kept in the store. Small files in one call (`put`), large ones in chunks (design
// §23 "Chunked transfers": `begin`, `append` at the stored offset, `uploaded` to resume after a drop, `finish`;
// unfinished uploads expire), reads by range, caps per host. Plugins never see a path.

import { mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { arr, bytes, int, local, map, method, num, obj, str } from "../../next/contracts/index.ts";
import { ChordError, type Principal } from "../../next/data/index.ts";
import { invalid } from "../../next/data/internal.ts";
import { defineState } from "../../next/documents/index.ts";
import { type Ctx, defineFacet, type Facet } from "../../next/host/index.ts";
import { newToken } from "./secrets.ts";
import { Uploads } from "./uploads.ts";

/** A file as the index lists it. */
export type FileInfo = {
	readonly id: string;
	readonly name: string;
	readonly mime: string;
	readonly size: number;
	readonly created: number;
};

/** The caps of one host's files (bytes). */
export type FilesCaps = {
	/** The largest file: 256 MiB by default. */
	readonly maxFile?: number;
	/** All files together: 4 GiB by default. */
	readonly maxTotal?: number;
};

/** One file's fields in the index. */
const Entry = obj({ name: str(), mime: str(), size: int(), created: num() });

/** The host's files (one per host): the index, small and chunked writes, ranged reads, removal. */
export const Files = local("chord.app.files", {
	version: 1,
	params: {},
	members: {
		list: arr(obj({ id: str(), name: str(), mime: str(), size: int(), created: num() })),
		/** Stores a small file (at most 4 MiB) in one call; its id. */
		put: method(obj({ name: str(), mime: str(), bytes: bytes() }), str()),
		/** Starts a chunked upload; its upload id. `unavailable` (`busy`) while the host's cap of uploads are under way. */
		begin: method(obj({ name: str(), mime: str() }), str()),
		/**
		 * Appends a chunk (at most 4 MiB; about 1 MiB is the usual size) to upload `upload` at `offset`, which must be
		 * the bytes stored so far (else `invalid`, its details `{ offset }` the stored one).
		 */
		append: method(obj({ upload: str(), offset: int({ min: 0 }), bytes: bytes() })),
		/** The bytes stored so far of upload `upload`: where a writer resumes after a drop. */
		uploaded: method(str(), int()),
		/** Ends upload `upload`: the file it made, its id. */
		finish: method(str(), str()),
		/** `length` bytes of file `id` from `offset` (fewer at its end). */
		read: method(obj({ id: str(), offset: int({ min: 0 }), length: int({ min: 0 }) }), bytes()),
		/** Removes file `id` (an unknown one: nothing). */
		remove: method(str()),
	},
});

/** The index document. */
const FilesIndex = defineState("chord.app.files", {
	schema: obj({ files: map(Entry) }),
	version: 1,
	initial: () => ({ files: {} }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
});

/** The largest piece a call carries (a `put`, an `append`, a `read`): 4 MiB, well under a link's part limit. */
const MAX_PIECE = 4 * 1024 * 1024;

/** How long an upload may go unwritten before it expires: an hour. */
const UPLOAD_IDLE_MS = 60 * 60_000;

/** How often expired uploads are dropped: every minute. */
const SWEEP_MS = 60_000;

/**
 * The kit's facet serving `Files` with the host's files directory `dir` (`<host dir>/files`), `caps` and at most
 * `uploads` uploads under way (64 by default). Uploads under way live in `dir/.uploads/<run>/` (`Uploads`) and end with
 * the object (an unfinished one is dropped when the next one goes live).
 */
export function filesFacet<P extends Principal>(dir: string, caps: FilesCaps = {}, uploads = 64): Facet<P> {
	const maxFile = caps.maxFile ?? 256 * 1024 * 1024;
	const maxTotal = caps.maxTotal ?? 4 * 1024 * 1024 * 1024;
	const uploadsDir = join(dir, ".uploads");
	return defineFacet<P>((host) =>
		host.serve(Files, (_params, self) => {
			const index = self.state(FilesIndex);
			// This run's uploads in their own directory: an upload left by an earlier run (its process ended) can never
			// finish and is dropped, while this run's may already have begun.
			const run = join(uploadsDir, newToken(12));
			const underway = new Uploads(run, uploads);
			// Uploads under way count against the total too: two of them cannot pass it together.
			const room = (adding: number, fileSize: number): void => {
				if (fileSize > maxFile)
					throw tooLarge(`a file of ${fileSize} bytes is larger than this host's cap (${maxFile})`);
				const stored = Object.values(index.value.files).reduce((sum, file) => sum + file.size, 0);
				if (stored + underway.size + adding > maxTotal) {
					throw tooLarge(`this host's files would exceed their cap (${maxTotal} bytes)`);
				}
			};
			self.onLive((ctx) => sweep(uploadsDir, run, underway, ctx));
			const fileOf = (id: string): FileInfo | undefined =>
				// A trust boundary: `id` is the caller's (`Object.hasOwn`: no inherited member is a file).
				Object.hasOwn(index.value.files, id) ? { id, ...index.value.files[id]! } : undefined;
			return {
				list: self.derive([index], ([value]) =>
					Object.entries(value.files).map(([id, { name, mime, size, created }]) => ({
						id,
						name,
						mime,
						size,
						created,
					})),
				),
				put: async ({ name, mime, bytes }, ctx) => {
					if (bytes.length > MAX_PIECE)
						throw tooLarge(`put takes at most ${MAX_PIECE} bytes: use begin, append, finish`);
					room(bytes.length, bytes.length);
					const id = newToken(12);
					await mkdir(dir, { recursive: true, mode: 0o700 });
					await writeFile(join(dir, id), bytes, { mode: 0o600 });
					await index.change((draft) => {
						draft.files[id] = { name, mime, size: bytes.length, created: Date.now() };
					}, ctx);
					return id;
				},
				begin: ({ name, mime }) => underway.begin(name, mime),
				append: async ({ upload, offset, bytes }) => {
					if (bytes.length > MAX_PIECE) throw tooLarge(`append takes at most ${MAX_PIECE} bytes`);
					await underway.append(upload, offset, bytes, room);
					return null;
				},
				uploaded: (upload) => underway.uploaded(upload),
				finish: async (upload, ctx) => {
					const id = newToken(12);
					await mkdir(dir, { recursive: true, mode: 0o700 });
					const { name, mime, size } = await underway.finish(upload, join(dir, id));
					await index.change((draft) => {
						draft.files[id] = { name, mime, size, created: Date.now() };
					}, ctx);
					return id;
				},
				read: async ({ id, offset, length }) => {
					const file = fileOf(id);
					if (file === undefined) throw invalid("args", `files: no file ${id}`);
					if (length > MAX_PIECE) throw tooLarge(`read takes at most ${MAX_PIECE} bytes`);
					const handle = await open(join(dir, id), "r");
					try {
						const buffer = new Uint8Array(Math.max(0, Math.min(length, file.size - offset)));
						const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
						return buffer.subarray(0, bytesRead);
					} finally {
						await handle.close();
					}
				},
				remove: async (id, ctx) => {
					if (fileOf(id) === undefined) return null;
					await index.change((draft) => {
						delete draft.files[id];
					}, ctx);
					await rm(join(dir, id), { force: true });
					return null;
				},
			};
		}),
	);
}

/**
 * The files object's routine once live: drops the uploads earlier runs left (every directory under `uploadsDir` but
 * `run`), then every minute the uploads unwritten for an hour; when the object ends, every upload still under way.
 */
async function sweep(uploadsDir: string, run: string, uploads: Uploads, ctx: Ctx): Promise<void> {
	for (const entry of await readdir(uploadsDir).catch(() => [])) {
		if (join(uploadsDir, entry) !== run) await rm(join(uploadsDir, entry), { recursive: true, force: true });
	}
	try {
		for (;;) {
			await sleep(SWEEP_MS, undefined, { signal: ctx.abortSignal });
			await uploads.expire(UPLOAD_IDLE_MS);
		}
	} finally {
		if (ctx.abortSignal?.aborted === true) await uploads.close();
	}
}

/** A cap refused a write. */
function tooLarge(message: string): ChordError {
	return new ChordError({ code: "too_large", message: `files: ${message}` });
}
