// Uploads of a session (POST /upload): their limit, their image types, and the materialized copies the model reads.
// The bytes live in the session's `Files` (space `uploads`); a message's attachments are written as plain files to the
// machine where the receiving conversation works before the message is admitted.
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { type Ctx, type Ref, safeFileName } from "@p2/app/v1";
import { FILE_CHUNK, type FileInfo, type Files } from "@p2/app/v1/node";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/** The image type of a file name (images may go to the model inline), else `undefined`. */
export function imageType(name: string): string | undefined {
	return IMAGE_TYPES[name.split(".").pop()?.toLowerCase() ?? ""];
}

/** An upload's path in the space `uploads`, and its materialized copies' file name: `<id>-<safe name>`. */
export function uploadPath(id: string, name: string): string {
	return `${id}-${safeFileName(name)}`;
}

/**
 * Writes upload `file` (path `name`) into the local directory `directory` (mode 0700, file 0600) unless a file of its
 * size is there: staged and renamed, so a reader never sees half of it. Its path.
 */
export async function materializeLocally(
	files: Ref<typeof Files>,
	file: FileInfo,
	directory: string,
	ctx: Ctx,
): Promise<string> {
	const path = join(directory, file.path);
	const existing = await stat(path).catch(() => undefined);
	if (existing?.isFile() && existing.size === file.size) return path;
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const staging = `${path}.${process.pid}.partial`;
	const output = createWriteStream(staging, { mode: 0o600 });
	try {
		for (let offset = 0; offset < file.size; ) {
			const bytes = await files.read({ id: file.id, offset, length: FILE_CHUNK }, ctx);
			if (!bytes.length) throw new Error(`Upload ${file.path} changed while read`);
			if (!output.write(bytes)) await new Promise<void>((resolve) => output.once("drain", () => resolve()));
			offset += bytes.length;
		}
		await new Promise<void>((resolve, reject) =>
			output.end((error?: Error | null) => (error ? reject(error) : resolve())),
		);
		await rename(staging, path);
	} catch (error) {
		output.destroy();
		await rm(staging, { force: true });
		throw error;
	}
	return path;
}

export class UploadError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}
