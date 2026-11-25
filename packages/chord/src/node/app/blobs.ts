// The blobs of one host's files (Files v2): immutable byte files under `<files>/blobs/`, named by id. A blob is
// written whole beside its place and moved there (a reader never sees part of one), never changed, and removed once no
// version references it. Blobs a write left without its index commit (a crash between the two) are swept.

import { constants } from "node:fs";
import { copyFile, link, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The blob files of one host, in `dir` (`<files>/blobs`). */
export class Blobs {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	/** Where blob `id` lives. */
	path(id: string): string {
		return join(this.dir, id);
	}

	/** Makes the directory (mode 0700) before a blob moves in. */
	async prepare(): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
	}

	/** Writes `bytes` as blob `id`: into `staging` (mode 0600), then moved into place. */
	async write(id: string, bytes: Uint8Array, staging: string): Promise<void> {
		await this.prepare();
		await mkdir(dirname(staging), { recursive: true, mode: 0o700 });
		await writeFile(staging, bytes, { mode: 0o600, flag: "wx" });
		await rename(staging, this.path(id));
	}

	/** Up to `length` bytes of blob `id` (of `size` bytes) from `offset`: fewer at its end. */
	async read(id: string, size: number, offset: number, length: number): Promise<Uint8Array> {
		const handle = await open(this.path(id), "r");
		try {
			const buffer = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
			return buffer.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
	}

	/** Removes the blobs `ids` (a missing one: nothing). */
	async remove(ids: readonly string[]): Promise<void> {
		for (const id of ids) await rm(this.path(id), { force: true });
	}

	/** Removes every blob file `known` does not know: what writes left that never committed. */
	async sweep(known: (id: string) => Promise<boolean>): Promise<void> {
		for (const id of await readdir(this.dir).catch(() => [])) {
			if (!(await known(id))) await rm(this.path(id), { force: true });
		}
	}

	/**
	 * Puts blob `id` into `target` (another host's blob directory): a hard link (blobs never change, so two hosts may
	 * share the file), a copy where the file system refuses links.
	 */
	async linkInto(id: string, target: string): Promise<void> {
		await link(this.path(id), join(target, id)).catch(async (error: NodeJS.ErrnoException) => {
			if (error.code === "EEXIST") throw error;
			await copyFile(this.path(id), join(target, id), constants.COPYFILE_EXCL);
		});
	}
}
