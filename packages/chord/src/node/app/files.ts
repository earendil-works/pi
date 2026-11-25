// Files (slice 13 §4; decision "Files v2"): the kit's file storage, one `Files` object per host (`self.get(Files, {})`),
// its bytes in the host's `files/` and its index in the host's store (`files-index.ts`). Every file lives in a space
// (`shared`, `artifacts`, `uploads`, …) at a path (`docs/report.md`); folders are index entries, and a move changes only
// the index. Bytes never change: writing to a path adds a version (a new blob), `copy` shares a blob, and a blob goes
// once no version references it. Small files in one call (`put`), large ones in chunks (design §23 "Chunked transfers":
// `begin`, `append` at the stored offset, `uploaded` to resume after a drop, `finish`; unfinished uploads expire); a
// `key` makes a write idempotent; reads by range; caps per host; a summary per space for an app's server index;
// `FilesFolder` lists one folder live. Plugins never see a path on disk.

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Context } from "../../context/index.ts";
import {
	arr,
	bool,
	bytes,
	int,
	keyed,
	lit,
	local,
	method,
	nul,
	obj,
	opt,
	type Schema,
	str,
	union,
} from "../../contracts/index.ts";
import { ChordError, type Principal } from "../../data/index.ts";
import { invalid } from "../../data/internal.ts";
import { type Ctx, defineFacet, type Facet } from "../../host/index.ts";
import { Blobs } from "./blobs.ts";
import {
	checkPath,
	checkSpace,
	type FileInfo,
	FileSchema,
	FilesIndex,
	type FileWrite,
	FolderSchema,
	MAX_PAGE,
	MetaSchema,
	SummarySchema,
} from "./files-index.ts";
import { type FolderListing, FolderViews } from "./folder-views.ts";
import { newToken } from "./secrets.ts";
import { Uploads } from "./uploads.ts";

export type { FileInfo, FileWrite, FolderEntry, FolderInfo, SpaceSummary } from "./files-index.ts";
export type { FolderListing } from "./folder-views.ts";

/** The caps of one host's files (bytes). */
export type FilesCaps = {
	/** The largest file: 256 MiB by default. */
	readonly maxFile?: number;
	/** All blobs on disk together (a copy shares its blob), uploads under way included: 4 GiB by default. */
	readonly maxTotal?: number;
};

/**
 * A write's fields: where, its type, who wrote it (a string the writer sets), its producer's reference, key, `meta`, and
 * an import's original time.
 */
const WRITE = {
	space: str(),
	path: str(),
	mime: str(),
	source: str(),
	ref: opt(str({ min: 1 })),
	key: opt(str({ min: 1 })),
	meta: opt(MetaSchema),
	/** For imports only: when the file was made where it comes from (ms since the epoch); the write's time otherwise. */
	created: opt(int({ min: 0 })),
};

/** A page's arguments: a cursor of the page before, and how many (100 by default, at most 1,000). */
const PAGE = { after: opt(str()), limit: opt(int({ min: 1, max: MAX_PAGE })) };

/** A page of `item`s and the cursor of the next one. */
const pageOf = <T>(item: Schema<T>) => obj({ items: arr(item), next: opt(str()) });

/** A version or nothing. */
const MAYBE_FILE = union([FileSchema, nul()]);

/** One entry of a folder's listing. */
const EntrySchema = union([
	obj({ kind: lit("folder"), folder: FolderSchema }),
	obj({ kind: lit("file"), file: FileSchema }),
]);

/** The host's files (one per host): writes, reads, the index's queries, folders, moves, copies, removal, summaries. */
export const Files = local("chord.app.files", {
	version: 2,
	params: {},
	members: {
		/** Each space's summary (counts, bytes, the newest versions): what an app mirrors to its server's index. */
		summary: keyed(SummarySchema),
		/**
		 * Stores a small file (at most 4 MiB) in one call as a new version at `path`, one past the highest it ever had.
		 * A `key` the space has already stores nothing and answers the version written with it.
		 */
		put: method(obj({ ...WRITE, bytes: bytes() }), FileSchema),
		/**
		 * Starts a chunked upload of what `finish` stores as `put` would: its upload id; with a `key` the space has, the
		 * version written with it (`exists`), or the upload under way with it. `unavailable` (`busy`) while the host's cap
		 * of uploads are under way.
		 */
		begin: method(
			obj(WRITE),
			union([obj({ kind: lit("upload"), upload: str() }), obj({ kind: lit("exists"), file: FileSchema })]),
		),
		/**
		 * Appends a chunk (at most 4 MiB; about 1 MiB is the usual size) to upload `upload` at `offset`, which must be
		 * the bytes stored so far (else `invalid`, its details `{ offset }` the stored one).
		 */
		append: method(obj({ upload: str(), offset: int({ min: 0 }), bytes: bytes() })),
		/** The bytes stored so far of upload `upload`: where a writer resumes after a drop. */
		uploaded: method(str(), int()),
		/** Ends upload `upload`: the version it made. */
		finish: method(str(), FileSchema),
		/** Drops upload `upload` and what it stored (an unknown one: nothing): its writer gave up. */
		cancel: method(str()),
		/** `length` bytes (at most 4 MiB) of version `id` from `offset` (fewer at its end). */
		read: method(obj({ id: str(), offset: int({ min: 0 }), length: int({ min: 0 }) }), bytes()),
		/** Version `id`, or `null`. */
		file: method(str(), MAYBE_FILE),
		/** Version `version` of the file at `path` (its newest without one), or `null`. */
		get: method(obj({ space: str(), path: str(), version: opt(int({ min: 1 })) }), MAYBE_FILE),
		/** The version written with `key` in `space`, or `null`. */
		byKey: method(obj({ space: str(), key: str({ min: 1 }) }), MAYBE_FILE),
		/** A page of the versions with `ref` in `space`, oldest first. */
		byRef: method(obj({ space: str(), ref: str({ min: 1 }), ...PAGE }), pageOf(FileSchema)),
		/** A page of the versions of the file at `path`, newest first. */
		versions: method(obj({ space: str(), path: str(), ...PAGE }), pageOf(FileSchema)),
		/** A page of folder `folder`'s entries (`""`: the space's root): its folders, then its files' newest versions. */
		list: method(obj({ space: str(), folder: str(), ...PAGE }), pageOf(EntrySchema)),
		/** Makes folder `path` and its missing parents (an existing one: itself); refused where a file is. */
		mkdir: method(obj({ space: str(), path: str() }), FolderSchema),
		/**
		 * Moves (renames) the file or folder `from` to `to`, changing only the index; refused when `to` exists or lies
		 * inside `from`.
		 */
		move: method(obj({ space: str(), from: str(), to: str() })),
		/** Copies version `id` as a new version at `path` of `space`, sharing its blob (its metadata but its key). */
		copy: method(obj({ id: str(), space: str(), path: str() }), FileSchema),
		/** Removes version `id` (an unknown one: nothing); the next older version becomes the path's newest. */
		remove: method(str()),
		/** Removes the file at `path` (every version) or the folder at `path` with everything under it. */
		removePath: method(obj({ space: str(), path: str() })),
		/** Removes everything in space `space`. */
		removeSpace: method(str()),
	},
});

/** One folder of the host's files, live: its first 500 entries (folders, then files) and whether more follow. */
export const FilesFolder = local("chord.app.files.folder", {
	version: 1,
	params: { space: str(), folder: str() },
	members: { listing: obj({ entries: arr(EntrySchema), more: bool() }) },
});

/** The largest piece a call carries (a `put`, an `append`, a `read`): 4 MiB, well under a link's part limit. */
const MAX_PIECE = 4 * 1024 * 1024;

/** A page's size when the caller names none. */
const PAGE_SIZE = 100;

/** How many entries a `FilesFolder` shows. */
const FOLDER_VIEW = 500;

/** How long an upload may go unwritten before it expires: an hour. */
const UPLOAD_IDLE_MS = 60 * 60_000;

/** How often expired uploads are dropped: every minute. */
const SWEEP_MS = 60_000;

/**
 * The kit's facet serving `Files` and `FilesFolder` with the host's files directory `dir` (`<host dir>/files`),
 * `caps` and at most `uploads` uploads under way (64 by default). Blobs live in `dir/blobs/`, uploads under way in
 * `dir/.uploads/<run>/` (`Uploads`), ending with the object (an unfinished one is dropped when the next one goes live).
 * For apps that host their own hosts; `startServer` and `startWorker` load it on theirs.
 */
export function filesFacet<P extends Principal>(dir: string, caps: FilesCaps = {}, uploads = 64): Facet<P> {
	const maxFile = caps.maxFile ?? 256 * 1024 * 1024;
	const maxTotal = caps.maxTotal ?? 4 * 1024 * 1024 * 1024;
	const uploadsDir = join(dir, ".uploads");
	const blobs = new Blobs(join(dir, "blobs"));
	const views = new FolderViews();
	return defineFacet<P>((host) => {
		host.serve(Files, (_params, self) => {
			const index = new FilesIndex(self);
			// This run's uploads in their own directory: an upload left by an earlier run (its process ended) can never
			// finish and is dropped, while this run's may already have begun.
			const run = join(uploadsDir, newToken(12));
			const underway = new Uploads<FileWrite>(run, uploads);
			views.bind(async (space, folder, ctx) => {
				const page = await index.list(space, folder, FOLDER_VIEW, undefined, ctx);
				return { entries: page.items, more: page.next !== undefined };
			});
			// Changes take turns: a version number, a key and a blob's count are decided by the one change running.
			let last: Promise<unknown> = Promise.resolve();
			const turn = <R>(fn: () => Promise<R>): Promise<R> => {
				const result = last.then(fn);
				last = result.catch(() => {});
				return result;
			};
			// Uploads under way count against the total too: two of them cannot pass it together.
			const room = (adding: number, fileSize: number): void => {
				if (fileSize > maxFile)
					throw tooLarge(`a file of ${fileSize} bytes is larger than this host's cap (${maxFile})`);
				if (index.usage.value.bytes + underway.size + adding > maxTotal) {
					throw tooLarge(`this host's files would exceed their cap (${maxTotal} bytes)`);
				}
			};
			// A new blob's version; the blob goes again when its index commit fails.
			const store = async (write: FileWrite, blob: string, size: number, ctx: Ctx): Promise<FileInfo> => {
				try {
					const file = await index.add(newToken(12), write, { id: blob, size, fresh: true }, ctx);
					await views.changed(write.space, ctx);
					return file;
				} catch (error) {
					await blobs.remove([blob]);
					throw error;
				}
			};
			const known = async (write: FileWrite, ctx: Ctx): Promise<FileInfo | undefined> =>
				write.key === undefined ? undefined : index.byKey(write.space, write.key, ctx);
			self.onLive((ctx) =>
				sweep(uploadsDir, run, underway, () => turn(() => blobs.sweep((id) => index.hasBlob(id, ctx))), ctx),
			);
			return {
				summary: index.summary,
				put: ({ bytes, ...write }, ctx) => {
					checkWrite(write);
					if (bytes.length > MAX_PIECE)
						throw tooLarge(`put takes at most ${MAX_PIECE} bytes: use begin, append, finish`);
					return turn(async () => {
						const existing = await known(write, ctx);
						if (existing !== undefined) return existing;
						room(bytes.length, bytes.length);
						const blob = newToken(12);
						await blobs.write(blob, bytes, join(run, `put-${blob}`)).catch(async (error: unknown) => {
							await rm(join(run, `put-${blob}`), { force: true });
							throw error;
						});
						return store(write, blob, bytes.length, ctx);
					});
				},
				begin: (write, ctx) => {
					checkWrite(write);
					return turn(async () => {
						const existing = await known(write, ctx);
						if (existing !== undefined) return { kind: "exists" as const, file: existing };
						const resumed = underway.find(
							(data) => data.space === write.space && data.key !== undefined && data.key === write.key,
						);
						if (resumed !== undefined) return { kind: "upload" as const, upload: resumed };
						if ((await index.exists(write.space, write.path, ctx)) === "folder")
							throw invalid("args", `files: ${write.space}:${write.path} is a folder`, { conflict: write.path });
						return { kind: "upload" as const, upload: await underway.begin(write) };
					});
				},
				append: async ({ upload, offset, bytes }) => {
					if (bytes.length > MAX_PIECE) throw tooLarge(`append takes at most ${MAX_PIECE} bytes`);
					await underway.append(upload, offset, bytes, room);
					return null;
				},
				uploaded: (upload) => underway.uploaded(upload),
				finish: (upload, ctx) =>
					turn(async () => {
						const blob = newToken(12);
						await blobs.prepare();
						const { data, size } = await underway.finish(upload, blobs.path(blob));
						const existing = await known(data, ctx);
						if (existing === undefined) return store(data, blob, size, ctx);
						await blobs.remove([blob]);
						return existing;
					}),
				cancel: async (upload) => {
					await underway.cancel(upload);
					return null;
				},
				read: async ({ id, offset, length }, ctx) => {
					if (length > MAX_PIECE) throw tooLarge(`read takes at most ${MAX_PIECE} bytes`);
					const found = await index.blobOf(id, ctx);
					if (found === undefined) throw invalid("args", `files: no file ${id}`);
					return blobs.read(found.blob, found.size, offset, length);
				},
				file: async (id, ctx) => (await index.file(id, ctx)) ?? null,
				get: async ({ space, path, version }, ctx) => {
					checkSpace(space);
					checkPath(path, "file");
					return (await index.get(space, path, version, ctx)) ?? null;
				},
				byKey: async ({ space, key }, ctx) => {
					checkSpace(space);
					return (await index.byKey(space, key, ctx)) ?? null;
				},
				byRef: ({ space, ref, after, limit }, ctx) => {
					checkSpace(space);
					return index.byRef(space, ref, limit ?? PAGE_SIZE, after, ctx);
				},
				versions: ({ space, path, after, limit }, ctx) => {
					checkSpace(space);
					checkPath(path, "file");
					return index.versions(space, path, limit ?? PAGE_SIZE, after, ctx);
				},
				list: ({ space, folder, after, limit }, ctx) => {
					checkSpace(space);
					checkPath(folder, "folder");
					return index.list(space, folder, limit ?? PAGE_SIZE, after, ctx);
				},
				mkdir: ({ space, path }, ctx) => {
					checkSpace(space);
					checkPath(path, "file");
					return turn(async () => {
						const folder = await index.mkdir(space, path, ctx);
						await views.changed(space, ctx);
						return folder;
					});
				},
				move: ({ space, from, to }, ctx) => {
					checkSpace(space);
					checkPath(from, "file");
					checkPath(to, "file");
					return turn(async () => {
						await index.move(space, from, to, ctx);
						await views.changed(space, ctx);
						return null;
					});
				},
				copy: ({ id, space, path }, ctx) => {
					checkSpace(space);
					checkPath(path, "file");
					return turn(async () => {
						const [file, found] = [await index.file(id, ctx), await index.blobOf(id, ctx)];
						if (file === undefined || found === undefined) throw invalid("args", `files: no file ${id}`);
						const { mime, source, ref, meta } = file;
						const write = {
							space,
							path,
							mime,
							source,
							...(ref === undefined ? {} : { ref }),
							...(meta === undefined ? {} : { meta }),
						};
						const copied = await index.add(
							newToken(12),
							write,
							{ id: found.blob, size: found.size, fresh: false },
							ctx,
						);
						await views.changed(space, ctx);
						return copied;
					});
				},
				remove: (id, ctx) =>
					turn(async () => {
						const removed = await index.remove(id, ctx);
						if (removed === undefined) return null;
						await blobs.remove(removed.gone);
						await views.changed(removed.space, ctx);
						return null;
					}),
				removePath: ({ space, path }, ctx) => {
					checkSpace(space);
					checkPath(path, "file");
					return turn(async () => {
						await blobs.remove(await index.removePath(space, path, ctx));
						await views.changed(space, ctx);
						return null;
					});
				},
				removeSpace: (space, ctx) => {
					checkSpace(space);
					return turn(async () => {
						await blobs.remove(await index.removeSpace(space, ctx));
						await views.changed(space, ctx);
						return null;
					});
				},
			};
		});
		host.serve(FilesFolder, ({ space, folder }, self) => {
			checkSpace(space);
			checkPath(folder, "folder");
			// Its listing is read through the host's `Files`, which must be live first.
			self.get(Files, {});
			return { listing: self.follow<FolderListing>((observer, ctx) => views.attach(space, folder, observer, ctx)) };
		});
	});
}

/** Refuses a write's space or path outside the rules (a trust boundary: the caller's). */
function checkWrite(write: FileWrite): void {
	checkSpace(write.space);
	checkPath(write.path, "file");
}

/**
 * The files object's routine once live: drops the uploads earlier runs left (every directory under `uploadsDir` but
 * `run`) and the blobs no commit took (`sweepBlobs`), then every minute the uploads unwritten for an hour; when the
 * object ends, every upload still under way.
 */
async function sweep(
	uploadsDir: string,
	run: string,
	uploads: Uploads<FileWrite>,
	sweepBlobs: () => Promise<void>,
	ctx: Context,
): Promise<void> {
	for (const entry of await readdir(uploadsDir).catch(() => [])) {
		if (join(uploadsDir, entry) !== run) await rm(join(uploadsDir, entry), { recursive: true, force: true });
	}
	try {
		await sweepBlobs();
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
