// File responses (slice 10 §2; decision "Slice 10 fix round, three small points" (1)): a file as a `bytes` response.
// `fileResponse` stats the file at once (with a `root`, its real path must lie inside it); the file handle is opened by
// the first `read` and closed when the request's scope seals (its signal aborts), so a response nobody writes (`HEAD`,
// a 416, a disconnect, a wrap that replaced it) opens nothing and leaks nothing.

import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import { basename, extname, sep } from "node:path";
import type { Context } from "../../context/index.ts";
import { HttpFailure } from "./request.ts";
import type { HttpResponse } from "./response.ts";

/** What `fileResponse` takes besides the path. */
export type FileResponseOptions = {
	/** Saved under this name. */
	readonly download?: string;
	/** Shown in the browser instead of saved (an image, a video), with a `sandbox` CSP. */
	readonly inline?: true;
	/**
	 * The directory the file must lie in once its symbolic links are resolved: one outside it (a link out) is refused
	 * 403. Without it the path is trusted (a plugin's own file).
	 */
	readonly root?: string;
	/** Whether a single range is answered 206 (audio and video seek with it). */
	readonly ranges?: boolean;
	/** The type; by default from the extension (text, images, audio, video), else `application/octet-stream`. */
	readonly mime?: string;
};

/**
 * The file at `path` as a `bytes` response; `HttpFailure` 404 for a missing one (anyone may ask for one: no failure
 * of the route, Fable's recheck N1), 403 for one outside `root`; throws what else `stat` throws.
 */
export async function fileResponse(given: string, options: FileResponseOptions = {}): Promise<HttpResponse> {
	let path: string;
	let size: number;
	try {
		path = options.root === undefined ? given : await inside(given, options.root);
		({ size } = await stat(path));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") throw new HttpFailure(404, "no such file");
		throw error;
	}
	let handle: Promise<FileHandle> | undefined;
	const read = async (offset: number, length: number, context: Context): Promise<Uint8Array> => {
		handle ??= opened(path, context);
		const file = await handle;
		// Only the bytes read are handed out.
		const buffer = Buffer.allocUnsafe(length);
		const { bytesRead } = await file.read(buffer, 0, length, offset);
		return buffer.subarray(0, bytesRead);
	};
	return {
		kind: "bytes",
		mime: options.mime ?? mimeOf(path),
		size,
		read,
		...(options.download === undefined ? {} : { download: options.download }),
		...(options.inline === undefined ? {} : { inline: options.inline }),
		...(options.ranges === undefined ? {} : { ranges: options.ranges }),
	};
}

/** The real path of `path` when it lies inside `root`'s real path; `HttpFailure` 403 otherwise. */
async function inside(path: string, root: string): Promise<string> {
	const [real, base] = await Promise.all([realpath(path), realpath(root)]);
	if (real !== base && !real.startsWith(base.endsWith(sep) ? base : base + sep)) {
		throw new HttpFailure(403, "the file lies outside its root");
	}
	return real;
}

/** Opens `path`, closed when `context` (the request's scope) aborts; at once when it aborted already. */
async function opened(path: string, context: Context): Promise<FileHandle> {
	const file = await open(path, "r");
	const close = (): void => void file.close().catch(() => {});
	const signal = context.abortSignal;
	if (signal === undefined) throw new Error(`fileResponse(${basename(path)}): read outside a request's scope`);
	if (signal.aborted) close();
	else signal.addEventListener("abort", close, { once: true });
	return file;
}

const MIME: Readonly<Record<string, string>> = {
	".txt": "text/plain; charset=utf-8",
	".log": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".ogg": "audio/ogg",
	".opus": "audio/ogg",
	".wav": "audio/wav",
	".flac": "audio/flac",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
};

/**
 * The type of `path` by its extension: text, images, audio and video only. Active types (HTML, SVG) never come from
 * here: a route serving one names it (`mime`).
 */
function mimeOf(path: string): string {
	return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}
