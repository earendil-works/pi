// Bounded, snapshot-based artifact reads, including continuation inside very long lines.
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import type { TextContent } from "@earendil-works/pi-ai";
import { type OutputArtifacts, utf8PrefixEnd } from "./output-artifacts.ts";

export interface ArtifactPage {
	uri: string;
	byteOffset: number;
	endByteOffset: number;
	totalBytes: number;
	nextByteOffset?: number;
}

export interface ArtifactReadInput {
	path: string;
	offset?: number;
	limit?: number;
	byteOffset?: number;
}

/** Read one UTF-8-safe page, honoring line selection and returning exact byte continuation metadata. */
export async function readArtifact(
	store: OutputArtifacts,
	input: ArtifactReadInput,
	signal?: AbortSignal,
): Promise<{ content: TextContent[]; details: { artifactPage: ArtifactPage }; structuredContent: string }> {
	const { path, offset, limit, byteOffset } = input;
	// These range rules are the artifact wire boundary; ordinary file read ranges retain their existing semantics.
	if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 1))
		throw new Error("Artifact offset must be a positive safe integer (1-indexed line number)");
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
		throw new Error("Artifact limit must be a positive safe integer");
	if (byteOffset !== undefined && (!Number.isSafeInteger(byteOffset) || byteOffset < 0))
		throw new Error("Artifact byteOffset must be a non-negative safe integer");
	if (offset !== undefined && byteOffset !== undefined)
		throw new Error("Use either offset or byteOffset for an artifact, not both");
	signal?.throwIfAborted();
	const handle = await open(store.resolve(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const { size } = await handle.stat();
		const start = byteOffset ?? (await findLineStart(handle, size, offset ?? 1, signal));
		if (start > size) throw new Error(`Artifact byteOffset ${start} is beyond the captured output (${size} bytes)`);
		const budget = store.budget();
		const reserve = Buffer.byteLength(footer(path, size, size, size, true)) + 1;
		const capacity = Math.max(4, Math.min(budget.maxChars, budget.maxBytes) - reserve);
		const bytes = Buffer.allocUnsafe(Math.min(capacity + 4, size - start));
		let count = 0;
		while (count < bytes.length) {
			signal?.throwIfAborted();
			const read = await handle.read(bytes, count, bytes.length - count, start + count);
			if (read.bytesRead === 0) break;
			count += read.bytesRead;
		}
		const captured = bytes.subarray(0, count);
		let end = utf8PrefixEnd(captured, Math.min(capacity, count));
		if (limit !== undefined) {
			let lines = 0;
			for (let index = 0; index < end; index++) {
				if (captured[index] === 0x0a && ++lines === limit) {
					end = index + 1;
					break;
				}
			}
		}
		const endByteOffset = start + end;
		const more = endByteOffset < size;
		const body = captured.subarray(0, end).toString("utf8");
		const page: ArtifactPage = {
			uri: path,
			byteOffset: start,
			endByteOffset,
			totalBytes: size,
			...(more ? { nextByteOffset: endByteOffset } : {}),
		};
		signal?.throwIfAborted();
		return {
			content: [
				{ type: "text", text: body },
				{ type: "text", text: footer(path, start, endByteOffset, size, more) },
			],
			details: { artifactPage: page },
			structuredContent: body,
		};
	} finally {
		await handle.close();
	}
}

function footer(uri: string, start: number, end: number, size: number, more: boolean): string {
	return `\n[Artifact bytes ${start}–${end} of ${size} (end exclusive, snapshot). ${more ? `Continue: read path="${uri}" byteOffset=${end}.` : "End of captured output."}]`;
}

async function findLineStart(
	handle: FileHandle,
	size: number,
	requested: number,
	signal?: AbortSignal,
): Promise<number> {
	if (requested === 1) return 0;
	const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size));
	let position = 0;
	let line = 1;
	while (position < size) {
		signal?.throwIfAborted();
		const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
		if (bytesRead === 0) break;
		for (let index = 0; index < bytesRead; index++) {
			if (buffer[index] === 0x0a && ++line === requested) return position + index + 1;
		}
		position += bytesRead;
	}
	throw new Error(`Artifact offset ${requested} is beyond the captured output (${line} lines)`);
}
