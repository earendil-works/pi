import * as fs from "node:fs";

export interface AppendedFileChunk {
	chunk: string;
	newOffset: number;
}

/**
 * Read only the bytes appended to a file since a previous offset.
 *
 * This is intended for tailing growing JSONL logs without re-reading the whole file.
 *
 * Behavior:
 * - If the file shrank (size < offset), treats this as truncation/rotation and reads from 0.
 * - Returns UTF-8 decoded text.
 */
export function readAppendedFileChunkSync(filePath: string, offset: number): AppendedFileChunk {
	let stats: fs.Stats;
	try {
		stats = fs.statSync(filePath);
	} catch {
		return { chunk: "", newOffset: offset };
	}

	const size = stats.size;
	const effectiveOffset = offset <= size ? offset : 0;

	if (size <= effectiveOffset) {
		return { chunk: "", newOffset: size };
	}

	const bytesToRead = size - effectiveOffset;
	const fd = fs.openSync(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(bytesToRead);
		const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, effectiveOffset);
		return { chunk: buffer.subarray(0, bytesRead).toString("utf8"), newOffset: effectiveOffset + bytesRead };
	} finally {
		fs.closeSync(fd);
	}
}
