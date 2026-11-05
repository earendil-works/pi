// The file operations the directory-backed sync pieces need, as an interface: any environment that has them (Node,
// a container, a remote host) can back a sync remote or the host's sync state. Shaped as Pi Durable's `FileSystem`
// (`@earendil-works/pi-durable/env`), so its environments pass as they are.

import type { Context } from "../context/index.ts";

/** An operation's outcome: its value, or the error it failed with. */
export type FileResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error };

/** A directory entry. */
export type SyncFileInfo = { readonly name: string; readonly kind: "file" | "directory" | "symlink" };

/** A file opened for reads at offsets: what streaming a body back needs. */
export interface SyncFileReader {
	/** Up to `length` bytes at `offset`; fewer only at end of file. */
	read(offset: number, length: number, context: Context): Promise<FileResult<Uint8Array>>;
	close(context: Context): Promise<void>;
}

/** File operations for the directory-backed sync pieces. A missing file or directory fails with `code: "not_found"`. */
export interface SyncFileSystem {
	joinPath(parts: string[], context: Context): Promise<FileResult<string>>;
	readTextFile(path: string, context: Context): Promise<FileResult<string>>;
	readBinaryFile(path: string, context: Context): Promise<FileResult<Uint8Array>>;
	/** Open a file for bounded reads, so a body streams back without being read whole. */
	openBinaryReader(
		path: string,
		options: { noFollow?: boolean } | undefined,
		context: Context,
	): Promise<FileResult<SyncFileReader>>;
	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<FileResult<void>>;
	/** Append to a file, creating it: a body is written chunk by chunk as it streams. */
	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<FileResult<void>>;
	renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<FileResult<void>>;
	listDir(path: string, context: Context): Promise<FileResult<SyncFileInfo[]>>;
	createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<FileResult<void>>;
	remove(
		path: string,
		options: { recursive?: boolean; force?: boolean } | undefined,
		context: Context,
	): Promise<FileResult<void>>;
}

/** Whether `result` failed because the file or directory is missing. */
export function isNotFound(result: FileResult<unknown>): boolean {
	return !result.ok && (result.error as { readonly code?: unknown }).code === "not_found";
}

export function unwrap<T>(result: FileResult<T>): T {
	if (!result.ok) throw result.error;
	return result.value;
}
