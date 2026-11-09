/**
 * Resolve `FileContent` blocks into provider references before a request is sent.
 *
 * The transcript keeps the local path, never the bytes. Gemini needs its own copy, so this module
 * uploads once per file version, remembers the result on disk, and hands the adapter a block with
 * `uri` filled in. A request that needs a still-processing video waits here, bounded by pi-ai's
 * Files API timeout; the block stays in the transcript either way, so a later turn picks it up.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	Api,
	BaseModel,
	FetchFunction,
	FileContent,
	MediaTransferProgress,
	Message,
	ProviderHeaders,
} from "@earendil-works/pi-ai";
import { type GoogleFile, uploadGoogleFile, waitForGoogleFileActive } from "@earendil-works/pi-ai/api/google-files";
import { mediaModalityForMimeType } from "@earendil-works/pi-ai/utils/media";
import { getAgentDir } from "../config.ts";

/** Re-upload when Google expires the file within this window, instead of failing mid-conversation. */
const CACHE_EXPIRY_MARGIN_MS = 10 * 60 * 1000;

/** The model fields media resolution reads. Any chat model satisfies this. */
export type MediaTarget = Pick<BaseModel<Api>, "api" | "provider" | "id" | "baseUrl" | "input">;

/** What one request resolved at most once: its credentials, its transport, and its cancellation. */
export interface ResolveFileContentOptions {
	model: MediaTarget;
	apiKey?: string;
	headers?: ProviderHeaders;
	fetch?: FetchFunction;
	signal?: AbortSignal;
	/** Reports the wait a request pays for media that is not uploaded yet. */
	onProgress?: (progress: MediaTransferProgress) => void;
}

/**
 * Fill in `uri` and `provider` on every file block this model can use, returning new messages.
 * Returns the same array when the model cannot take references or nothing is pending.
 */
export async function resolveFileContent(messages: Message[], options: ResolveFileContentOptions): Promise<Message[]> {
	const { model, apiKey } = options;
	if (model.api !== "google-generative-ai" || !apiKey) return messages;

	const pending = pendingFiles(messages, model);
	if (pending.length === 0) return messages;

	const uploads = new Map<string, Promise<GoogleFile>>();
	const resolved = new Map<FileContent, FileContent>();
	for (const file of pending) {
		let upload = uploads.get(file.path);
		if (!upload) {
			upload = uploadedFile(file, { ...options, apiKey });
			uploads.set(file.path, upload);
		}
		const uploaded = await upload;
		resolved.set(file, {
			...file,
			uri: uploaded.uri,
			provider: model.provider,
			sizeBytes: uploaded.sizeBytes ?? file.sizeBytes,
		});
	}

	return messages.map((message) => {
		if (message.role !== "user" || !Array.isArray(message.content)) return message;
		if (!message.content.some((block) => block.type === "file" && resolved.has(block))) return message;
		return {
			...message,
			content: message.content.map((block) => (block.type === "file" ? (resolved.get(block) ?? block) : block)),
		};
	});
}

/** File blocks this request still has to upload, skipping the ones the model cannot take anyway. */
function pendingFiles(messages: Message[], model: MediaTarget): (FileContent & { path: string })[] {
	const files: (FileContent & { path: string })[] = [];
	for (const message of messages) {
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type !== "file") continue;
			if (block.path === undefined) continue;
			if (block.uri && block.provider === model.provider) continue;
			const modality = mediaModalityForMimeType(block.mimeType);
			if (modality === undefined || !model.input.includes(modality)) continue;
			// The check above established a path; the cast only tells the checker, and the block
			// identity must stay original so the resolved copy can replace it in place.
			files.push(block as FileContent & { path: string });
		}
	}
	return files;
}

async function uploadedFile(
	file: FileContent & { path: string },
	options: ResolveFileContentOptions & { apiKey: string },
): Promise<GoogleFile> {
	const stats = await stat(file.path).catch((error: unknown) => {
		throw new Error(`Could not read ${label(file)} at ${file.path}`, { cause: error });
	});
	const key = uploadCacheKey(file.path, file.mimeType, stats.size, stats.mtimeMs);
	const cached = await readCachedUpload(key);
	if (cached) return cached;

	const context = {
		baseUrl: options.model.baseUrl,
		apiKey: options.apiKey,
		headers: headerRecord(options.headers),
		fetch: options.fetch,
		signal: options.signal,
	};
	const report = (progress: Omit<MediaTransferProgress, "name">) =>
		options.onProgress?.({ ...progress, name: label(file) });
	try {
		const upload = await uploadGoogleFile(
			context,
			{ path: file.path, mimeType: file.mimeType, displayName: file.name ?? basename(file.path) },
			{
				onUploadProgress: (uploadedBytes, totalBytes) => report({ stage: "upload", uploadedBytes, totalBytes }),
				onProcessing: (elapsedMs) => report({ stage: "processing", elapsedMs }),
			},
		);
		const active = await waitForGoogleFileActive(context, upload, {
			onProcessing: (elapsedMs) => report({ stage: "processing", elapsedMs }),
		});
		await writeCachedUpload(key, active);
		report({ stage: "ready" });
		return active;
	} catch (error) {
		if (options.signal?.aborted) throw error;
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not upload ${label(file)} to Gemini: ${reason}`, { cause: error });
	}
}

/** Cache key per file version: the same bytes at the same path upload once, an edit uploads again. */
function uploadCacheKey(path: string, mimeType: string, sizeBytes: number, mtimeMs: number): string {
	return createHash("sha256").update([path, mimeType, sizeBytes, mtimeMs].join("\0")).digest("hex");
}

function uploadCacheDir(): string {
	return join(getAgentDir(), "media-cache", "google");
}

async function readCachedUpload(key: string): Promise<GoogleFile | undefined> {
	let raw: string;
	try {
		raw = await readFile(join(uploadCacheDir(), `${key}.json`), "utf8");
	} catch {
		return undefined;
	}
	const cached = parseCachedUpload(raw);
	if (!cached) return undefined;
	if (cached.expiresAt !== undefined && cached.expiresAt - Date.now() < CACHE_EXPIRY_MARGIN_MS) return undefined;
	return cached;
}

async function writeCachedUpload(key: string, file: GoogleFile): Promise<void> {
	const dir = uploadCacheDir();
	await mkdir(dir, { recursive: true });
	const entry = {
		name: file.name,
		uri: file.uri,
		mimeType: file.mimeType,
		sizeBytes: file.sizeBytes,
		expiresAt: file.expiresAt,
	};
	await writeFile(join(dir, `${key}.json`), JSON.stringify(entry));
}

/** On-disk cache input: a corrupt or partial entry just means uploading again. */
function parseCachedUpload(raw: string): GoogleFile | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const entry = parsed as Record<string, unknown>;
	if (typeof entry.uri !== "string" || typeof entry.name !== "string") return undefined;
	return {
		name: entry.name,
		uri: entry.uri,
		mimeType: typeof entry.mimeType === "string" ? entry.mimeType : "application/octet-stream",
		state: "ACTIVE",
		...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
		...(typeof entry.expiresAt === "number" ? { expiresAt: entry.expiresAt } : {}),
	};
}

/** Request headers carry nulls to suppress provider defaults; the Files API takes plain strings. */
function headerRecord(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const record: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== null) record[name] = value;
	}
	return Object.keys(record).length > 0 ? record : undefined;
}

function label(file: FileContent): string {
	return file.name ?? (file.path ? basename(file.path) : file.mimeType);
}
