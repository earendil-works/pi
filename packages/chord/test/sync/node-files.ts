// `SyncFileSystem` over Node's file system, for the sync tests (a host passes its own environment, such as Pi Durable's
// `NodeExecutionEnv`).

import { appendFile, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileResult, SyncFileInfo, SyncFileReader, SyncFileSystem } from "../../src/sync/index.ts";

/** An error with a `code`: `not_found` for a missing file or directory, as `SyncFileSystem` reports it. */
class FileError extends Error {
	readonly code: string;
	constructor(code: string, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.code = code;
	}
}

async function attempt<T>(operation: () => Promise<T>): Promise<FileResult<T>> {
	try {
		return { ok: true, value: await operation() };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_found" : "unknown";
		return { ok: false, error: new FileError(code, error) };
	}
}

export const nodeFiles: SyncFileSystem = {
	joinPath: async (parts) => ({ ok: true, value: join(...parts) }),
	readTextFile: (path) => attempt(() => readFile(path, "utf8")),
	readBinaryFile: (path) => attempt(async () => new Uint8Array(await readFile(path))),
	openBinaryReader: (path) =>
		attempt(async (): Promise<SyncFileReader> => {
			const file = await open(path, "r");
			return {
				read: (offset, length) =>
					attempt(async () => {
						const buffer = new Uint8Array(length);
						const { bytesRead } = await file.read(buffer, 0, length, offset);
						return buffer.subarray(0, bytesRead);
					}),
				close: async () => {
					await file.close();
				},
			};
		}),
	writeFile: (path, content) => attempt(() => writeFile(path, content)),
	appendFile: (path, content) => attempt(() => appendFile(path, content)),
	renameFile: (source, destination) => attempt(() => rename(source, destination)),
	listDir: (path) =>
		attempt(async () =>
			(await readdir(path, { withFileTypes: true })).map(
				(entry): SyncFileInfo => ({
					name: entry.name,
					kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
				}),
			),
		),
	createDir: (path, options) => attempt(async () => void (await mkdir(path, options))),
	remove: (path, options) => attempt(() => rm(path, options)),
};
