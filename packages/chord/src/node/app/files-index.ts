// The index of one host's files (Files v2, decision "Files v2"): four tables of the host's store and two documents.
// `files` holds one row per version (its space, folder, path, version, blob, size, metadata), `folders` one row per
// folder, `blobs` one row per blob on disk with its reference count, `paths` each path's highest version ever (kept
// through removals: no number is used twice for a path); the `summary` document per space (counts, bytes, the newest
// versions) is what an app mirrors to its server, the `usage` document the bytes on disk the caps count. Reads by id,
// by path, by folder, by `ref` and by `key`; every change is one transaction, computed by its caller's turn (the
// object runs one change at a time), so a version number, a key and a blob's count are decided once.

import type { Context } from "../../context/index.ts";
import { arr, int, obj, opt, type Schema, str, unknown } from "../../contracts/index.ts";
import type { Principal } from "../../data/index.ts";
import { invalid } from "../../data/internal.ts";
import { defineState, type KeyedHandle, type SingletonHandle, type Tx } from "../../documents/index.ts";
import type { StoreSelf } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import {
	add,
	and,
	type ColumnRefs,
	type Condition,
	defineTable,
	eq,
	json,
	lt,
	ne,
	not,
	or,
	type Page,
	prefix,
	query,
	type RowOf,
	replacePrefix,
	sub,
	type Table,
} from "../../store/index.ts";

/** One version of a file as the index gives it. */
export type FileInfo = {
	readonly id: string;
	readonly space: string;
	readonly path: string;
	readonly version: number;
	readonly size: number;
	readonly mime: string;
	readonly source: string;
	readonly ref?: string;
	readonly key?: string;
	readonly created: number;
	readonly meta?: JsonValue;
};

/** A folder as the index gives it. */
export type FolderInfo = { readonly space: string; readonly path: string; readonly created: number };

/** One entry of a folder's listing: a folder, or a file's newest version. */
export type FolderEntry =
	| { readonly kind: "folder"; readonly folder: FolderInfo }
	| { readonly kind: "file"; readonly file: FileInfo };

/** What a space holds: its files (paths), their versions, their bytes (every version's) and the newest versions. */
export type SpaceSummary = {
	readonly files: number;
	readonly versions: number;
	readonly bytes: number;
	readonly newest: FileInfo[];
};

/**
 * What a write stores besides its bytes: where, its type, who wrote it, its producer's reference, its key, `meta`, and
 * for an import the time the file was made elsewhere (`created`, ms since the epoch; the write's time otherwise).
 */
export type FileWrite = {
	readonly space: string;
	readonly path: string;
	readonly mime: string;
	readonly source: string;
	readonly ref?: string;
	readonly key?: string;
	readonly created?: number;
	readonly meta?: JsonValue;
};

/** `meta`'s schema: any JSON (stored as one JSON cell, so what is written is JSON; the schema cannot say so). */
export const MetaSchema = unknown() as Schema<JsonValue>;

/** A file version's schema (`FileInfo`). */
export const FileSchema = obj({
	id: str(),
	space: str(),
	path: str(),
	version: int(),
	size: int(),
	mime: str(),
	source: str(),
	ref: opt(str()),
	key: opt(str()),
	created: int(),
	meta: opt(MetaSchema),
});

/** A folder's schema (`FolderInfo`). */
export const FolderSchema = obj({ space: str(), path: str(), created: int() });

/** A space summary's schema (`SpaceSummary`). */
export const SummarySchema = obj({ files: int(), versions: int(), bytes: int(), newest: arr(FileSchema) });

/** The columns of a file version. `ref` and `key` are `""` when absent (index columns are never `opt`). */
const fileColumns = {
	id: str(),
	space: str(),
	folder: str(),
	path: str(),
	version: int(),
	latest: int(),
	blob: str(),
	size: int(),
	mime: str(),
	source: str(),
	ref: str(),
	key: str(),
	created: int(),
	meta: opt(json(unknown(), { version: 1 })),
};

/** The rows of file versions. */
const FileRows = defineTable("files", {
	version: 1,
	columns: fileColumns,
	key: ["id"],
	indexes: {
		by_folder: ["space", "folder", "latest", "path"],
		by_path: ["space", "path", "version"],
		by_ref: ["space", "ref", "created"],
		by_key: ["space", "key"],
		by_created: ["space", "created"],
	},
});

/** The columns of a folder. */
const folderColumns = { id: str(), space: str(), parent: str(), path: str(), created: int() };

/** The rows of folders (the root, `""`, has none). */
const FolderRows = defineTable("folders", {
	version: 1,
	columns: folderColumns,
	key: ["id"],
	indexes: { by_path: ["space", "path"], by_parent: ["space", "parent", "path"] },
});

/** The columns of a path's high-water mark: the highest version it ever had. */
const markColumns = { space: str(), path: str(), last: int() };

/**
 * The highest version each path ever had, kept when its versions or the path itself are removed, so a version number
 * is never used twice for a path (links name a version by path and number).
 */
const MarkRows = defineTable("paths", {
	version: 1,
	columns: markColumns,
	key: ["space", "path"],
});

/** The columns of a blob. */
const blobColumns = { id: str(), size: int(), refs: int() };

/** The blobs on disk and how many versions reference each. */
const BlobRows = defineTable("blobs", {
	version: 1,
	columns: blobColumns,
	key: ["id"],
});

/** The summary of each space, by space. */
const Summaries = defineState("summary", {
	schema: SummarySchema,
	version: 1,
	initial: (): SpaceSummary => ({ files: 0, versions: 0, bytes: 0, newest: [] }),
	keyed: true,
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
});

/** The bytes of every blob on disk: what the host's total cap counts. */
const Usage = defineState("usage", {
	schema: obj({ bytes: int() }),
	version: 1,
	initial: () => ({ bytes: 0 }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
});

/** How many of a space's newest versions its summary keeps. */
export const NEWEST = 20;

/** The most a page holds. */
export const MAX_PAGE = 1000;

/** A blob a new version references: a fresh one (just written) or one other versions share. */
export type BlobUse = { readonly id: string; readonly size: number; readonly fresh: boolean };

/**
 * One host's index of files, over its object's tables and documents. Reads see committed state; each change is one
 * transaction and returns the blobs no version references any more (for the caller to delete).
 */
export class FilesIndex {
	readonly summary: KeyedHandle<SpaceSummary>;
	readonly usage: SingletonHandle<{ bytes: number }>;
	readonly #files: Table<typeof fileColumns, readonly ["id"]>;
	readonly #folders: Table<typeof folderColumns, readonly ["id"]>;
	readonly #blobs: Table<typeof blobColumns, readonly ["id"]>;
	readonly #marks: Table<typeof markColumns, readonly ["space", "path"]>;
	readonly #self: StoreSelf<Principal>;

	/** The index of the object `self` declares it in (its factory's). */
	constructor(self: StoreSelf<Principal>) {
		this.#files = self.table(FileRows);
		this.#folders = self.table(FolderRows);
		this.#blobs = self.table(BlobRows);
		this.#marks = self.table(MarkRows);
		this.summary = self.state(Summaries);
		this.usage = self.state(Usage);
		this.#self = self;
	}

	/** The version `id`, or `undefined`. */
	async file(id: string, context: Context): Promise<FileInfo | undefined> {
		const row = await this.#files.get({ id }, context);
		return row === undefined ? undefined : infoOf(row);
	}

	/** The blob of version `id` and its size, or `undefined`. */
	async blobOf(id: string, context: Context): Promise<{ blob: string; size: number } | undefined> {
		const row = await this.#files.get({ id }, context);
		return row === undefined ? undefined : { blob: row.blob, size: row.size };
	}

	/** Version `version` of the file at `path` (its newest without one), or `undefined`. */
	async get(
		space: string,
		path: string,
		version: number | undefined,
		context: Context,
	): Promise<FileInfo | undefined> {
		const row = await this.#version(space, path, version, context);
		return row === undefined ? undefined : infoOf(row);
	}

	/** The version written with `key` in `space`, or `undefined`. */
	async byKey(space: string, key: string, context: Context): Promise<FileInfo | undefined> {
		const q = query(FileRows).where((f) => and(eq(f.space, space), eq(f.key, key)));
		const [row] = (await this.#files.page(q, 1, context)).items;
		return row === undefined ? undefined : infoOf(row);
	}

	/** A page of the versions with `ref` in `space`, oldest first. */
	async byRef(space: string, ref: string, limit: number, after: string | undefined, context: Context) {
		const q = query(FileRows)
			.where((f) => and(eq(f.space, space), eq(f.ref, ref)))
			.orderBy((f) => f.created);
		return infos(await this.#files.page(q, limit, context, after === undefined ? {} : { after }));
	}

	/** A page of the versions of the file at `path`, newest first. */
	async versions(space: string, path: string, limit: number, after: string | undefined, context: Context) {
		const q = query(FileRows)
			.where((f) => and(eq(f.space, space), eq(f.path, path)))
			.orderBy((f) => f.version, "desc");
		return infos(await this.#files.page(q, limit, context, after === undefined ? {} : { after }));
	}

	/**
	 * A page of folder `folder`'s entries (`""` is the root): its folders, then its files' newest versions, each by
	 * path. The cursor names the part it continues.
	 */
	async list(
		space: string,
		folder: string,
		limit: number,
		after: string | undefined,
		context: Context,
	): Promise<Page<FolderEntry>> {
		const cursor = listCursor(after);
		const entries: FolderEntry[] = [];
		const folders = query(FolderRows)
			.where((f) => and(eq(f.space, space), eq(f.parent, folder)))
			.orderBy((f) => f.path);
		const files = query(FileRows)
			.where((f) => and(eq(f.space, space), eq(f.folder, folder), eq(f.latest, 1)))
			.orderBy((f) => f.path);
		if (cursor.part === "folders") {
			const page = await this.#folders.page(folders, limit, context, cursor.after);
			for (const row of page.items) entries.push({ kind: "folder", folder: folderOf(row) });
			if (page.next !== undefined) return { items: entries, next: JSON.stringify({ folders: page.next }) };
		}
		const room = limit - entries.length;
		const options = cursor.part === "files" ? cursor.after : {};
		// A page the folders filled continues with the files only when there are some.
		const page = await this.#files.page(files, Math.max(room, 1), context, options);
		if (room === 0) return page.items.length === 0 ? { items: entries } : { items: entries, next: '{"files":null}' };
		for (const row of page.items) entries.push({ kind: "file", file: infoOf(row) });
		return page.next === undefined
			? { items: entries }
			: { items: entries, next: JSON.stringify({ files: page.next }) };
	}

	/** Whether the file or folder `path` exists in `space`. */
	async exists(space: string, path: string, context: Context): Promise<"file" | "folder" | undefined> {
		if ((await this.#folder(space, path, context)) !== undefined) return "folder";
		return (await this.#version(space, path, undefined, context)) === undefined ? undefined : "file";
	}

	/** Adds a version at `write.path` referencing `blob`: version 1, or one past the newest; its folders made. */
	async add(id: string, write: FileWrite, blob: BlobUse, context: Context): Promise<FileInfo> {
		const { space, path } = write;
		if ((await this.#folder(space, path, context)) !== undefined) throw clash(space, path, "is a folder");
		const folders = await this.#missingFolders(space, parentOf(path), context);
		const previous = await this.#version(space, path, undefined, context);
		const mark = await this.#marks.get({ space, path }, context);
		const row = {
			id,
			space,
			folder: parentOf(path),
			path,
			version: Math.max(previous?.version ?? 0, mark?.last ?? 0) + 1,
			latest: 1,
			blob: blob.id,
			size: blob.size,
			mime: write.mime,
			source: write.source,
			ref: write.ref ?? "",
			key: write.key ?? "",
			created: write.created ?? Date.now(),
			...(write.meta === undefined || write.meta === null ? {} : { meta: write.meta }),
		};
		const info = infoOf(row);
		const newest = (await this.summary.get(space, context))?.newest ?? [];
		await this.#self.tx(async (tx) => {
			for (const folder of folders) tx.put(this.#folders, folder);
			if (previous !== undefined) tx.update(this.#files, { id: previous.id }, { latest: 0 });
			tx.put(this.#files, row);
			tx.put(this.#marks, { space, path, last: row.version });
			if (blob.fresh) tx.put(this.#blobs, { id: blob.id, size: blob.size, refs: 1 });
			else tx.update(this.#blobs, { id: blob.id }, (b) => ({ refs: add(b.refs, 1) }));
			if (blob.fresh) (await tx.draft(this.usage)).bytes += blob.size;
			const summary = await tx.draft(this.summary, space);
			summary.files += previous === undefined ? 1 : 0;
			summary.versions += 1;
			summary.bytes += blob.size;
			summary.newest = [info, ...newest].sort(newestFirst).slice(0, NEWEST);
		}, context);
		return info;
	}

	/** Makes folder `path` and its missing parents; refused where a file is. */
	async mkdir(space: string, path: string, context: Context): Promise<FolderInfo> {
		const folders = await this.#missingFolders(space, path, context);
		if (folders.length > 0) {
			await this.#self.tx(async (tx) => {
				for (const folder of folders) tx.put(this.#folders, folder);
			}, context);
		}
		return folderOf((await this.#folder(space, path, context))!);
	}

	/**
	 * Moves the file or folder `from` to `to` (in `space`), changing only the index: every version of a file, everything
	 * under a folder. Refused when `from` does not exist, `to` exists or lies inside `from`. Versions keep their numbers;
	 * the paths left keep their marks, and each path moved to takes the higher of its own mark and the moved one's.
	 */
	async move(space: string, from: string, to: string, context: Context): Promise<void> {
		const kind = await this.exists(space, from, context);
		if (kind === undefined) throw invalid("args", `files: ${space}:${from} does not exist`);
		if (to === from || to.startsWith(`${from}/`)) throw clash(space, to, `lies inside ${from}`);
		if ((await this.exists(space, to, context)) !== undefined) throw clash(space, to, "exists");
		const folders = await this.#missingFolders(space, parentOf(to), context);
		const moved = kind === "folder" ? await this.#folder(space, from, context) : undefined;
		const renamed = (path: string): string => (path === from ? to : `${to}${path.slice(from.length)}`);
		const newest = ((await this.summary.get(space, context))?.newest ?? []).map((file) =>
			file.path === from || file.path.startsWith(`${from}/`) ? { ...file, path: renamed(file.path) } : file,
		);
		const marks = await this.#movedMarks(space, from, renamed, context);
		await this.#self.tx(async (tx) => {
			for (const folder of folders) tx.put(this.#folders, folder);
			for (const mark of marks) tx.put(this.#marks, mark);
			if (moved === undefined) {
				tx.updateWhere(this.#files, (f) => and(eq(f.space, space), eq(f.path, from)), {
					path: to,
					folder: parentOf(to),
				});
			} else {
				tx.update(this.#folders, { id: moved.id }, { path: to, parent: parentOf(to) });
				tx.updateWhere(
					this.#folders,
					(f) => and(eq(f.space, space), prefix(f.path, `${from}/`)),
					(f) => ({
						path: replacePrefix(f.path, `${from}/`, `${to}/`),
						parent: replacePrefix(f.parent, from, to),
					}),
				);
				tx.updateWhere(
					this.#files,
					(f) => and(eq(f.space, space), prefix(f.path, `${from}/`)),
					(f) => ({
						path: replacePrefix(f.path, `${from}/`, `${to}/`),
						folder: replacePrefix(f.folder, from, to),
					}),
				);
			}
			if (newest.length > 0) (await tx.draft(this.summary, space)).newest = newest;
		}, context);
	}

	/** The marks of the paths `renamed` moves (`from` and those under it), each the higher of its own and the target's. */
	async #movedMarks(space: string, from: string, renamed: (path: string) => string, context: Context) {
		const marks: RowOf<typeof markColumns>[] = [];
		const q = query(MarkRows).where((m) => and(eq(m.space, space), or(eq(m.path, from), prefix(m.path, `${from}/`))));
		for await (const mark of this.#marks.rows(q, context)) {
			const path = renamed(mark.path);
			const target = await this.#marks.get({ space, path }, context);
			marks.push({ space, path, last: Math.max(mark.last, target?.last ?? 0) });
		}
		return marks;
	}

	/**
	 * Removes version `id` (an unknown one: nothing, `undefined`); the next older version becomes the path's newest.
	 * Its space and the blobs no version references any more.
	 */
	async remove(id: string, context: Context): Promise<{ space: string; gone: string[] } | undefined> {
		const row = await this.#files.get({ id }, context);
		if (row === undefined) return undefined;
		const older =
			row.latest === 1
				? (
						await this.#files.page(
							query(FileRows)
								.where((f) => and(eq(f.space, row.space), eq(f.path, row.path), lt(f.version, row.version)))
								.orderBy((f) => f.version, "desc"),
							1,
							context,
						)
					).items[0]
				: undefined;
		const pathGone = row.latest === 1 && older === undefined;
		const gone = await this.#drop(
			row.space,
			[row],
			pathGone ? 1 : 0,
			(f) => ne(f.id, id),
			context,
			(tx) => {
				tx.delete(this.#files, { id });
				if (older !== undefined) tx.update(this.#files, { id: older.id }, { latest: 1 });
			},
		);
		return { space: row.space, gone };
	}

	/** Removes the file at `path` (every version) or the folder at `path` and everything under it. */
	async removePath(space: string, path: string, context: Context): Promise<string[]> {
		const under = (column: Parameters<typeof prefix>[0]): Condition =>
			or(eq(column, path), prefix(column, `${path}/`));
		const rows = [];
		for await (const row of this.#files.rows(
			query(FileRows).where((f) => and(eq(f.space, space), under(f.path))),
			context,
		)) {
			rows.push(row);
		}
		const files = new Set(rows.map((row) => row.path)).size;
		return this.#drop(
			space,
			rows,
			files,
			(f) => not(under(f.path)),
			context,
			(tx) => {
				tx.deleteWhere(this.#files, (f) => and(eq(f.space, space), under(f.path)));
				tx.deleteWhere(this.#folders, (f) => and(eq(f.space, space), under(f.path)));
			},
		);
	}

	/** Removes everything in `space`, its summary included. */
	async removeSpace(space: string, context: Context): Promise<string[]> {
		const rows = [];
		for await (const row of this.#files.rows(
			query(FileRows).where((f) => eq(f.space, space)),
			context,
		)) {
			rows.push(row);
		}
		const released = await this.#released(rows, context);
		await this.#self.tx(async (tx) => {
			tx.deleteWhere(this.#files, (f) => eq(f.space, space));
			tx.deleteWhere(this.#folders, (f) => eq(f.space, space));
			await this.#release(tx, released);
			await tx.retire(this.summary, space);
		}, context);
		return released.gone;
	}

	/** Whether blob `id` is referenced (a blob file without a row is a leftover of a write that never committed). */
	async hasBlob(id: string, context: Context): Promise<boolean> {
		return (await this.#blobs.get({ id }, context)) !== undefined;
	}

	/**
	 * Removes `rows` (versions of `space`, `files` paths gone with them) in one transaction with `writes`: their blobs'
	 * counts lowered, the summary's counts lowered and its newest versions read again among the rows `kept`.
	 */
	async #drop(
		space: string,
		rows: readonly FileRow[],
		files: number,
		kept: (f: ColumnRefs<typeof fileColumns>) => Condition,
		context: Context,
		writes: (tx: Tx) => void,
	): Promise<string[]> {
		const released = await this.#released(rows, context);
		const bytes = rows.reduce((sum, row) => sum + row.size, 0);
		const newest = await this.#files.page(
			query(FileRows)
				.where((f) => and(eq(f.space, space), kept(f)))
				.orderBy((f) => f.created, "desc"),
			NEWEST,
			context,
		);
		await this.#self.tx(async (tx) => {
			writes(tx);
			await this.#release(tx, released);
			const summary = await tx.draft(this.summary, space);
			summary.files -= files;
			summary.versions -= rows.length;
			summary.bytes -= bytes;
			summary.newest = newest.items.map(infoOf);
		}, context);
		return released.gone;
	}

	/** What removing `rows` does to their blobs: each blob's lowered count, and the blobs left without a reference. */
	async #released(rows: readonly FileRow[], context: Context): Promise<Released> {
		const counts = new Map<string, number>();
		for (const row of rows) counts.set(row.blob, (counts.get(row.blob) ?? 0) + 1);
		const lowered: { id: string; by: number }[] = [];
		const gone: string[] = [];
		let bytes = 0;
		for (const [id, by] of counts) {
			const blob = await this.#blobs.get({ id }, context);
			if (blob === undefined) continue;
			if (blob.refs > by) lowered.push({ id, by });
			else {
				gone.push(id);
				bytes += blob.size;
			}
		}
		return { lowered, gone, bytes };
	}

	/** Stages `released`'s blob writes and the usage they free. */
	async #release(tx: Tx, released: Released): Promise<void> {
		for (const { id, by } of released.lowered) tx.update(this.#blobs, { id }, (b) => ({ refs: sub(b.refs, by) }));
		for (const id of released.gone) tx.delete(this.#blobs, { id });
		if (released.bytes > 0) (await tx.draft(this.usage)).bytes -= released.bytes;
	}

	/** Version `version` of `path` (its newest without one). */
	async #version(space: string, path: string, version: number | undefined, context: Context) {
		const q = query(FileRows).where((f) =>
			and(eq(f.space, space), eq(f.path, path), version === undefined ? eq(f.latest, 1) : eq(f.version, version)),
		);
		return (await this.#files.page(q, 1, context)).items[0];
	}

	/** The folder at `path`. */
	async #folder(space: string, path: string, context: Context) {
		const q = query(FolderRows).where((f) => and(eq(f.space, space), eq(f.path, path)));
		return (await this.#folders.page(q, 1, context)).items[0];
	}

	/** The rows of `path` and its parents that do not exist yet, parents first; refused where a file is. */
	async #missingFolders(space: string, path: string, context: Context): Promise<FolderRow[]> {
		const missing: FolderRow[] = [];
		const created = Date.now();
		for (const folder of foldersOf(path)) {
			if (missing.length === 0 && (await this.#folder(space, folder, context)) !== undefined) continue;
			if ((await this.#version(space, folder, undefined, context)) !== undefined)
				throw clash(space, folder, "is a file");
			missing.push({ id: crypto.randomUUID(), space, parent: parentOf(folder), path: folder, created });
		}
		return missing;
	}
}

/** A stored version. */
type FileRow = RowOf<typeof fileColumns>;

/** A stored folder. */
type FolderRow = RowOf<typeof folderColumns>;

/** What removing versions does to blobs. */
type Released = {
	readonly lowered: readonly { readonly id: string; readonly by: number }[];
	readonly gone: string[];
	readonly bytes: number;
};

/** A stored version as the index gives it. */
function infoOf(row: Omit<FileRow, "folder" | "latest" | "blob">): FileInfo {
	return {
		id: row.id,
		space: row.space,
		path: row.path,
		version: row.version,
		size: row.size,
		mime: row.mime,
		source: row.source,
		...(row.ref === "" ? {} : { ref: row.ref }),
		...(row.key === "" ? {} : { key: row.key }),
		created: row.created,
		// A json(unknown()) cell: JSON as it was written.
		...(row.meta === undefined ? {} : { meta: row.meta as JsonValue }),
	};
}

/** The order of a summary's newest versions, as `by_created` gives them: `created`, then id, descending. */
function newestFirst(a: FileInfo, b: FileInfo): number {
	return b.created - a.created || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** A page of stored versions as the index gives them. */
function infos(page: Page<FileRow>): Page<FileInfo> {
	const items = page.items.map(infoOf);
	return page.next === undefined ? { items } : { items, next: page.next };
}

/** A stored folder as the index gives it. */
function folderOf(row: FolderRow): FolderInfo {
	return { space: row.space, path: row.path, created: row.created };
}

/** Where a listing continues: in the folders or in the files, after a cursor of that part. */
type ListCursor =
	| { readonly part: "folders"; readonly after: { readonly after?: string } }
	| { readonly part: "files"; readonly after: { readonly after?: string } };

/** A listing's cursor, read back (a trust boundary: the caller's). */
function listCursor(after: string | undefined): ListCursor {
	if (after === undefined) return { part: "folders", after: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(after);
	} catch {
		throw invalid("args", "files: not a listing cursor");
	}
	const { folders, files } = (parsed ?? {}) as { folders?: unknown; files?: unknown };
	if (typeof folders === "string") return { part: "folders", after: { after: folders } };
	if (typeof files === "string") return { part: "files", after: { after: files } };
	if (files === null) return { part: "files", after: {} };
	throw invalid("args", "files: not a listing cursor");
}

/** The space name rule: lower case, digits, `.`, `_`, `-`, at most 64 characters. */
const SPACE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The longest path. */
const MAX_PATH = 1024;

/** Refuses a space name outside the rule (a trust boundary: the caller's). */
export function checkSpace(space: string): void {
	if (!SPACE.test(space)) throw invalid("args", `files: "${space}" is no space name (${SPACE.source})`);
}

/**
 * Refuses a path that is not `name/name/…` (a trust boundary: the caller's): no empty segment, no `.` or `..`, no NUL,
 * at most 1024 characters. `folder` allows `""`, the root.
 */
export function checkPath(path: string, folder: "folder" | "file"): void {
	if (folder === "folder" && path === "") return;
	const bad =
		path.length > MAX_PATH ||
		path.includes("\0") ||
		path.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
	if (bad) throw invalid("args", `files: "${path.slice(0, 80)}" is no path (name/name/…, at most ${MAX_PATH})`);
}

/** The folder `path` is in (`""`: the root). */
export function parentOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

/** Folder `path` and its parents, outermost first (none for the root). */
function foldersOf(path: string): string[] {
	if (path === "") return [];
	const segments = path.split("/");
	return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

/** A refusal of a path that is taken or would hold itself. */
function clash(space: string, path: string, why: string): Error {
	return invalid("args", `files: ${space}:${path} ${why}`, { conflict: path });
}
