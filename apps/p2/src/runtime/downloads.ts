// Immutable private snapshots of files for the browser to download (Node): written by producers (send_file, the
// workspace) on the server or a worker, served by the files plugin under `<data>/downloads/<session>/<id>/`.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type DownloadInfo, safeFileName } from "./files.ts";

export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DownloadError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** Immutable private snapshots. IDs locate files but never authorize access. */
export class Downloads {
	readonly directory: string;
	constructor(dataDirectory: string) {
		this.directory = join(dataDirectory, "downloads");
	}

	async save(sessionId: string, sourcePath: string, name?: string): Promise<DownloadInfo> {
		if (!ID.test(sessionId)) throw new DownloadError(400, "Invalid session");
		// NONBLOCK avoids hanging on a named pipe before fstat rejects non-regular sources.
		const source = await open(sourcePath, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
			throw new DownloadError(400, "Could not open source file");
		});
		try {
			const stat = await source.stat();
			if (!stat.isFile()) throw new DownloadError(400, "Source must be a regular file");
			const buffer = Buffer.alloc(64 * 1024);
			return await this.saveFrom(sessionId, name ?? basename(sourcePath), stat.size, async () => {
				const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
				return buffer.subarray(0, bytesRead);
			});
		} finally {
			await source.close();
		}
	}

	/**
	 * Snapshot an opened regular file of `size` bytes, read in order by `next` until it returns no bytes (a local
	 * handle or a session environment's reader). Capped at 25 MiB even if the file grows meanwhile.
	 */
	async saveFrom(
		sessionId: string,
		name: string,
		size: number,
		next: () => Promise<Uint8Array>,
	): Promise<DownloadInfo> {
		if (!ID.test(sessionId)) throw new DownloadError(400, "Invalid session");
		if (size > MAX_DOWNLOAD_BYTES) throw new DownloadError(413, "File exceeds 25 MiB");
		const id = randomUUID();
		const folder = join(this.directory, sessionId, id);
		let created = false;
		try {
			await mkdir(join(this.directory, sessionId), { recursive: true, mode: 0o700 });
			await mkdir(folder, { mode: 0o700 });
			created = true;
			const output = await open(join(folder, "payload"), "wx", 0o600);
			let written = 0;
			try {
				for (;;) {
					const bytes = await next();
					if (!bytes.length) break;
					written += bytes.length;
					if (written > MAX_DOWNLOAD_BYTES) throw new DownloadError(413, "File exceeds 25 MiB");
					await output.writeFile(bytes);
				}
			} finally {
				await output.close();
			}
			const info: DownloadInfo = { id, name: safeFileName(name), size: written };
			// Publish metadata last: an interrupted copy never becomes downloadable.
			await writeFile(join(folder, "metadata.json"), JSON.stringify(info), { flag: "wx", mode: 0o600 });
			return info;
		} catch (error) {
			if (created) await rm(folder, { recursive: true, force: true });
			throw error;
		}
	}

	async open(sessionId: string, id: string): Promise<{ info: DownloadInfo; handle: FileHandle }> {
		if (!ID.test(sessionId) || !ID.test(id)) throw new DownloadError(404, "File not found");
		const folder = join(this.directory, sessionId, id);
		let handle: FileHandle | undefined;
		try {
			const metadata = await open(
				join(folder, "metadata.json"),
				constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
			);
			let value: unknown;
			try {
				const stat = await metadata.stat();
				if (!stat.isFile() || stat.size > 2048) throw new Error("Invalid metadata");
				const buffer = Buffer.alloc(2049);
				const { bytesRead } = await metadata.read(buffer, 0, buffer.length, 0);
				if (bytesRead > 2048) throw new Error("Invalid metadata");
				value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
			} finally {
				await metadata.close();
			}
			if (
				!value ||
				typeof value !== "object" ||
				!("id" in value) ||
				value.id !== id ||
				!("name" in value) ||
				typeof value.name !== "string" ||
				value.name !== safeFileName(value.name) ||
				!("size" in value) ||
				typeof value.size !== "number" ||
				!Number.isSafeInteger(value.size) ||
				value.size < 0 ||
				value.size > MAX_DOWNLOAD_BYTES
			)
				throw new Error("Invalid metadata");
			handle = await open(join(folder, "payload"), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size !== value.size) throw new Error("Invalid snapshot");
			return { info: { id, name: value.name, size: value.size }, handle };
		} catch {
			await handle?.close();
			throw new DownloadError(404, "File not found");
		}
	}
}
