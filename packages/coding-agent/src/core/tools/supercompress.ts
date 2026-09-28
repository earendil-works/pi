/**
 * Optional preview for shell output that would be tail-truncated.
 *
 * Unset SUPERCOMPRESS_API_KEY and this module never runs. A failed call,
 * a timeout, or a preview that does not fit the existing line and byte caps
 * keeps the tail.
 */

import { readFile, stat } from "node:fs/promises";

export const SUPERCOMPRESS_URL = "https://api.supercompress.dev/v1/compress";

/** Matches the compress API's context limit. Larger spills stay on the tail cut. */
export const MAX_CONTEXT_CHARS = 120_000;
const MAX_QUERY_CHARS = 4_000;
const REQUEST_TIMEOUT_MS = 5_000;

export function latestUserText(messages: readonly unknown[] | undefined): string | undefined {
	if (!messages) return undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (typeof message !== "object" || message === null) continue;
		const record = message as { role?: unknown; content?: unknown };
		if (record.role !== "user") continue;
		const text = userContent(record.content).trim();
		if (text) return text.slice(0, MAX_QUERY_CHARS);
	}
	return undefined;
}

function userContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part !== "object" || part === null) return "";
			const record = part as { type?: unknown; text?: unknown };
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

export function fitsPreview(text: string, maxBytes: number, maxLines: number): boolean {
	if (Buffer.byteLength(text, "utf8") > maxBytes) return false;
	let lines = 1;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) lines++;
	}
	if (text.endsWith("\n")) lines--;
	return lines <= maxLines;
}

export async function previewFromSpill(options: {
	spillPath: string | undefined;
	query: string | undefined;
	maxBytes: number;
	maxLines: number;
	apiKey?: string;
	fetchImpl?: typeof fetch;
	readFileImpl?: (path: string) => Promise<string>;
	statImpl?: (path: string) => Promise<{ size: number }>;
}): Promise<string | null> {
	const spillPath = options.spillPath;
	const query = options.query?.trim();
	const apiKey = (options.apiKey ?? process.env.SUPERCOMPRESS_API_KEY ?? "").trim();
	if (!spillPath || !query || !apiKey) return null;

	try {
		const info = await (options.statImpl ?? stat)(spillPath);
		if (info.size > MAX_CONTEXT_CHARS) return null;
		const fullText = await (options.readFileImpl ?? ((path: string) => readFile(path, "utf8")))(spillPath);
		if (!fullText || fullText.length > MAX_CONTEXT_CHARS) return null;
		const compressed = await compressContext({
			context: fullText,
			query,
			apiKey,
			fetchImpl: options.fetchImpl,
		});
		if (!compressed) return null;
		const preview = `${compressed}\n\n[Full output: ${spillPath}]`;
		if (!fitsPreview(preview, options.maxBytes, options.maxLines)) return null;
		return preview;
	} catch {
		return null;
	}
}

export async function compressContext(args: {
	context: string;
	query: string;
	apiKey: string;
	fetchImpl?: typeof fetch;
}): Promise<string | null> {
	const context = args.context;
	const query = args.query.trim().slice(0, MAX_QUERY_CHARS);
	if (!context || !query || context.length > MAX_CONTEXT_CHARS) return null;
	const fetchImpl = args.fetchImpl ?? fetch;
	try {
		const response = await fetchImpl(SUPERCOMPRESS_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-Key": args.apiKey,
			},
			body: JSON.stringify({ context, query }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const body = (await response.json()) as { compressed_text?: unknown };
		const text = body.compressed_text;
		if (typeof text !== "string" || text.length === 0 || text.length >= context.length) return null;
		return text;
	} catch {
		return null;
	}
}
