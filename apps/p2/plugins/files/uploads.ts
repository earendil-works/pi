import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { safeFileName } from "@p2/app/v1";
import type { Attachment } from "./contract.ts";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ID = /^[0-9a-f-]{36}$/;
const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

// Uploads live under the data directory, never inside the project: they must
// not appear in git status or be committed by the agent by accident.
export class Uploads {
	readonly directory: string;
	constructor(dataDirectory: string) {
		this.directory = join(dataDirectory, "uploads");
	}

	static mimeType(name: string): string | undefined {
		return IMAGE_TYPES[name.split(".").pop()?.toLowerCase() ?? ""];
	}

	async save(sessionId: string, name: string, body: IncomingMessage): Promise<Attachment> {
		const declared = Number(body.headers["content-length"] ?? Number.NaN);
		if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) throw new UploadError(413, "File too large");
		const id = randomUUID();
		const safe = safeFileName(name);
		const folder = join(this.directory, sessionId);
		await mkdir(folder, { recursive: true, mode: 0o700 });
		const path = join(folder, `${id}-${safe}`);
		let size = 0;
		try {
			await pipeline(
				body,
				async function* (source: AsyncIterable<Buffer>) {
					for await (const chunk of source) {
						size += chunk.length;
						if (size > MAX_UPLOAD_BYTES) throw new UploadError(413, "File too large");
						yield chunk;
					}
				},
				createWriteStream(path, { mode: 0o600, flags: "wx" }),
			);
		} catch (error) {
			await rm(path, { force: true });
			throw error;
		}
		const mimeType = Uploads.mimeType(safe);
		return { id, name: safe, path, size, ...(mimeType ? { mimeType } : {}) };
	}

	/** Resolve client-supplied IDs to files this server wrote for that session. */
	async resolve(sessionId: string, ids: readonly string[]): Promise<Attachment[]> {
		if (!ids.length) return [];
		const folder = join(this.directory, sessionId);
		const files = await readdir(folder).catch(() => [] as string[]);
		return Promise.all(
			ids.map(async (id) => {
				const file = ID.test(id) ? files.find((entry) => entry.startsWith(`${id}-`)) : undefined;
				if (!file) throw new Error("Unknown attachment");
				const path = join(folder, file);
				const name = file.slice(id.length + 1);
				const mimeType = Uploads.mimeType(name);
				return { id, name, path, size: (await stat(path)).size, ...(mimeType ? { mimeType } : {}) };
			}),
		);
	}
}

export class UploadError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}
