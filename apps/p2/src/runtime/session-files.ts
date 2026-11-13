// A session's files in its worker's `Files` (the app kit's, one per host; brief "per-host stores", Part C): the spaces
// p2 writes (uploads, downloads), whole reads of a version, chunked writes from a reader, and the download
// snapshots producers (send_file) save. Node: the server and the session worker; plugins reach `Files` through
// `self.get(Files, {})` or `ctx.get(Files, {})` on the session's worker, never a path.
import { randomUUID } from "node:crypto";
import type { FileInfo, Files } from "@earendil-works/chord/app/files";
import type { Ctx, Ref } from "./chord.ts";
import { type DownloadInfo, safeFileName } from "./files.ts";

export { type FileInfo, Files, FilesFolder, type SpaceSummary } from "@earendil-works/chord/app/files";

/** The space of a session's uploads (POST /upload): path `<id>-<name>`, key = the upload's id. */
export const UPLOADS = "uploads";

/** The space of a session's download snapshots (send_file): path `<id>-<name>`, key = the download's id. */
export const DOWNLOADS = "downloads";

/** The largest download snapshot: 25 MiB. */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/** The largest piece `Files` takes or gives in one call. */
export const FILE_CHUNK = 1024 * 1024;

export class DownloadError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** The whole bytes of version `file` (read a chunk at a time). */
export async function readWhole(files: Ref<typeof Files>, file: FileInfo, ctx: Ctx): Promise<Buffer> {
	const chunks: Uint8Array[] = [];
	for (let offset = 0; offset < file.size; ) {
		const bytes = await files.read({ id: file.id, offset, length: FILE_CHUNK }, ctx);
		if (!bytes.length) throw new Error(`File ${file.path} changed while read`);
		chunks.push(bytes);
		offset += bytes.length;
	}
	return Buffer.concat(chunks);
}

/**
 * Writes the bytes `next` gives (until it gives none) as a new version (`write` as `Files.begin` takes it), at most
 * `max` bytes (`too large` past it); an upload that fails is dropped.
 */
export async function writeChunks(
	files: Ref<typeof Files>,
	write: Parameters<Ref<typeof Files>["begin"]>[0],
	next: () => Promise<Uint8Array>,
	max: number,
	ctx: Ctx,
): Promise<FileInfo> {
	const begun = await files.begin(write, ctx);
	if (begun.kind === "exists") return begun.file;
	try {
		let offset = 0;
		for (;;) {
			const bytes = await next();
			if (!bytes.length) break;
			if (offset + bytes.length > max) throw new DownloadError(413, `File exceeds ${max / 1024 / 1024} MiB`);
			for (let start = 0; start < bytes.length; start += FILE_CHUNK) {
				const chunk = bytes.subarray(start, start + FILE_CHUNK);
				await files.append({ upload: begun.upload, offset, bytes: chunk }, ctx);
				offset += chunk.length;
			}
		}
		return await files.finish(begun.upload, ctx);
	} catch (error) {
		await files.cancel(begun.upload, ctx).catch(() => {});
		throw error;
	}
}

/**
 * Saves a download snapshot of `name` (a display name, made safe) from the bytes `next` gives, written by `source`:
 * capped at 25 MiB even if the source grows meanwhile. Its id (a UUID) is the version's key, what `/download` names.
 */
export async function saveDownload(
	files: Ref<typeof Files>,
	snapshot: { readonly name: string; readonly size: number; readonly source: string; readonly ref?: string },
	next: () => Promise<Uint8Array>,
	ctx: Ctx,
): Promise<DownloadInfo> {
	if (snapshot.size > MAX_DOWNLOAD_BYTES) throw new DownloadError(413, "File exceeds 25 MiB");
	const id = randomUUID();
	const name = safeFileName(snapshot.name);
	const write = {
		space: DOWNLOADS,
		path: `${id}-${name}`,
		mime: "application/octet-stream",
		source: snapshot.source,
		key: id,
		meta: { name },
		...(snapshot.ref === undefined ? {} : { ref: snapshot.ref }),
	};
	const file = await writeChunks(files, write, next, MAX_DOWNLOAD_BYTES, ctx);
	return { id, name, size: file.size };
}

/** The download snapshot `id` of the session (`undefined` for anything else) and its display name. */
export async function findDownload(
	files: Ref<typeof Files>,
	id: string,
	ctx: Ctx,
): Promise<{ readonly file: FileInfo; readonly name: string } | undefined> {
	if (!id) return undefined;
	const file = await files.byKey({ space: DOWNLOADS, key: id }, ctx);
	if (file === null) return undefined;
	return { file, name: displayName(file) };
}

/** A file's display name: `meta.name` as p2 writes it, else its path's last segment. */
export function displayName(file: FileInfo): string {
	const meta = file.meta as { readonly name?: unknown } | undefined;
	return typeof meta?.name === "string" ? meta.name : (file.path.split("/").at(-1) ?? file.path);
}
