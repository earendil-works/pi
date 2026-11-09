/**
 * Google Gemini Files API: upload audio or video once, then reference it from a request by URI.
 *
 * Google processes an upload asynchronously: a video stays `PROCESSING` until it is `ACTIVE`, and
 * Google offers no notification. A request that needs the file therefore polls, and this module
 * bounds that wait with a timeout so a long video fails the turn instead of hanging it.
 */

import type * as NodeFs from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";
import type { FetchFunction } from "../types.ts";

/**
 * How long a request may wait for Google to finish processing an upload. There is no notification
 * channel, so the alternative to a bound is hanging until the stream is aborted by hand.
 */
export const GOOGLE_FILE_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

const PROCESSING_POLL_INITIAL_MS = 2_000;
const PROCESSING_POLL_MAX_MS = 10_000;
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const FILES_API_VERSION = "v1beta";
const MAX_ERROR_BODY_CHARS = 500;

/** Processing state of an uploaded file, as reported by the Files API. */
export type GoogleFileState = "PROCESSING" | "ACTIVE" | "FAILED" | "STATE_UNSPECIFIED";

/** An uploaded Gemini file, reduced to the fields pi stores and sends. */
export interface GoogleFile {
	/** Resource name, e.g. `files/abc123`. */
	name: string;
	/** URI to reference from `fileData.fileUri`. */
	uri: string;
	mimeType: string;
	sizeBytes?: number;
	state: GoogleFileState;
	/** Unix timestamp when Google deletes the upload, when reported. */
	expiresAt?: number;
}

/** Everything the Files API needs besides the bytes: where the API is and who is asking. */
export interface GoogleFilesContext {
	/** The model's base URL, e.g. `https://generativelanguage.googleapis.com/v1beta`. */
	baseUrl: string;
	apiKey: string;
	fetch?: FetchFunction;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	/** How long a request may wait for processing. Defaults to {@link GOOGLE_FILE_PROCESSING_TIMEOUT_MS}. */
	processingTimeoutMs?: number;
}

/** Called while bytes stream to Google, and once per poll while Google processes them. */
export interface GoogleFileProgress {
	onUploadProgress?(uploadedBytes: number, totalBytes: number): void;
	onProcessing?(elapsedMs: number): void;
}

export interface GoogleFileUploadInput {
	/** Absolute path to the bytes to upload. */
	path: string;
	mimeType: string;
	/** Label shown in the Gemini console. Defaults to the file name. */
	displayName?: string;
}

interface NodeFsModule {
	createReadStream: typeof NodeFs.createReadStream;
}

interface NodeFsPromisesModule {
	stat: typeof NodeFsPromises.stat;
}

// Variable specifier so browser bundlers do not try to resolve node builtins.
const importNodeModule = (specifier: string): Promise<unknown> => import(specifier);

/** Stream a file to the Files API in one resumable request. */
export async function uploadGoogleFile(
	ctx: GoogleFilesContext,
	input: GoogleFileUploadInput,
	progress?: GoogleFileProgress,
): Promise<GoogleFile> {
	const fs = (await importNodeModule("node:fs/promises")) as NodeFsPromisesModule;
	const { size } = await fs.stat(input.path);

	const start = await googleRequest(ctx, uploadUrl(ctx.baseUrl), {
		method: "POST",
		headers: {
			...ctx.headers,
			"x-goog-api-key": ctx.apiKey,
			"content-type": "application/json",
			"x-goog-upload-protocol": "resumable",
			"x-goog-upload-command": "start",
			"x-goog-upload-header-content-length": String(size),
			"x-goog-upload-header-content-type": input.mimeType,
		},
		body: JSON.stringify({ file: { display_name: input.displayName ?? fileName(input.path) } }),
		signal: ctx.signal,
	});

	const contentUrl = start.headers.get("x-goog-upload-url");
	if (!contentUrl) {
		throw new Error("Gemini Files API answered the upload without an upload URL");
	}

	const upload: RequestInit & { duplex: "half" } = {
		method: "POST",
		headers: {
			...ctx.headers,
			"x-goog-api-key": ctx.apiKey,
			"content-type": input.mimeType,
			"x-goog-upload-command": "upload, finalize",
			"x-goog-upload-offset": "0",
		},
		// undici streams an async iterable body with `duplex: "half"`; no body declaration covers it.
		body: (await countedFileStream(input.path, size, progress)) as unknown as RequestInit["body"],
		duplex: "half",
		signal: ctx.signal,
	};
	const response = await googleRequest(ctx, contentUrl, upload);
	// A partially accepted upload answers 200 too, with the status header left off `final`.
	if (response.headers.get("x-goog-upload-status") !== "final") {
		throw new Error(`Gemini Files API did not finish uploading ${fileName(input.path)}`);
	}

	return parseGoogleFile(await response.json());
}

/** Read one uploaded file's metadata, which is how processing progress is observed. */
export async function getGoogleFile(ctx: GoogleFilesContext, name: string): Promise<GoogleFile> {
	const response = await googleRequest(ctx, filesUrl(ctx.baseUrl, name), {
		method: "GET",
		headers: { ...ctx.headers, "x-goog-api-key": ctx.apiKey },
		signal: ctx.signal,
	});
	return parseGoogleFile(await response.json());
}

/** Delete an upload. Google also deletes files on its own after about two days. */
export async function deleteGoogleFile(ctx: GoogleFilesContext, name: string): Promise<void> {
	await googleRequest(ctx, filesUrl(ctx.baseUrl, name), {
		method: "DELETE",
		headers: { ...ctx.headers, "x-goog-api-key": ctx.apiKey },
		signal: ctx.signal,
	});
}

/**
 * Poll until Google reports the file `ACTIVE`. Throws when processing fails or takes longer than
 * the context allows, leaving the upload in place so a later request can pick it up.
 */
export async function waitForGoogleFileActive(
	ctx: GoogleFilesContext,
	file: GoogleFile,
	progress?: GoogleFileProgress,
): Promise<GoogleFile> {
	const startedAt = Date.now();
	const deadline = startedAt + (ctx.processingTimeoutMs ?? GOOGLE_FILE_PROCESSING_TIMEOUT_MS);
	let current = file;
	let delay = PROCESSING_POLL_INITIAL_MS;

	while (current.state === "PROCESSING" || current.state === "STATE_UNSPECIFIED") {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(
				`Gemini is still processing ${fileName(file.name)} after ${formatDuration(Date.now() - startedAt)}`,
			);
		}
		await sleep(Math.min(delay, remaining), ctx.signal);
		current = await getGoogleFile(ctx, current.name);
		progress?.onProcessing?.(Date.now() - startedAt);
		delay = Math.min(delay * 2, PROCESSING_POLL_MAX_MS);
	}

	if (current.state === "FAILED") {
		throw new Error(`Gemini could not process ${fileName(file.name)}`);
	}
	return current;
}

/** The un-versioned root the upload endpoint hangs off: uploads live at `/upload/<version>/files`. */
function uploadUrl(baseUrl: string): string {
	return `${stripApiVersion(baseUrl)}/upload/${FILES_API_VERSION}/files`;
}

/** Files are read back under the same API version the model's base URL already names. */
function filesUrl(baseUrl: string, name: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/${name}`;
}

/** pi's Google base URLs end in `/v1beta`; the upload path carries its own version. */
function stripApiVersion(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/(v1|v1alpha|v1beta)$/, "");
}

async function googleRequest(ctx: GoogleFilesContext, url: string, init: RequestInit): Promise<Response> {
	const fetchImpl = ctx.fetch ?? globalThis.fetch;
	const response = await fetchImpl(url, init);
	if (!response.ok) {
		const detail = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
		throw new Error(`Gemini Files API returned ${response.status} for ${init.method ?? "GET"} ${url}: ${detail}`);
	}
	return response;
}

/** The file as a stream that reports how many bytes left, so an upload of a large video shows progress. */
async function* countedFileStream(
	path: string,
	totalBytes: number,
	progress?: GoogleFileProgress,
): AsyncGenerator<Uint8Array> {
	const fs = (await importNodeModule("node:fs")) as NodeFsModule;
	// Nothing is opened until the request reads the body, so a failed request never leaks a handle.
	const file: AsyncIterable<Uint8Array> = fs.createReadStream(path, { highWaterMark: UPLOAD_CHUNK_BYTES });
	let uploadedBytes = 0;
	for await (const chunk of file) {
		uploadedBytes += chunk.length;
		progress?.onUploadProgress?.(uploadedBytes, totalBytes);
		yield chunk;
	}
}

/** Wire input: the Files API response is untyped JSON, so its shape is settled here. */
function parseGoogleFile(value: unknown): GoogleFile {
	if (typeof value !== "object" || value === null) {
		throw new Error("Gemini Files API returned no file");
	}
	// Uploading answers `{"file": {...}}`; reading one file answers the file itself.
	const body = value as Record<string, unknown>;
	const file = typeof body.file === "object" && body.file !== null ? (body.file as Record<string, unknown>) : body;
	const name = typeof file.name === "string" ? file.name : undefined;
	const uri = typeof file.uri === "string" ? file.uri : undefined;
	if (!name || !uri) {
		throw new Error("Gemini Files API returned a file without a name or URI");
	}

	const sizeBytes = typeof file.sizeBytes === "string" ? Number(file.sizeBytes) : Number.NaN;
	const expiresAt = typeof file.expirationTime === "string" ? Date.parse(file.expirationTime) : Number.NaN;
	return {
		name,
		uri,
		mimeType: typeof file.mimeType === "string" ? file.mimeType : "application/octet-stream",
		state: googleFileState(file.state),
		...(Number.isFinite(sizeBytes) ? { sizeBytes } : {}),
		...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
	};
}

function googleFileState(value: unknown): GoogleFileState {
	switch (value) {
		case "PROCESSING":
		case "ACTIVE":
		case "FAILED":
			return value;
		default:
			return "STATE_UNSPECIFIED";
	}
}

function fileName(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
