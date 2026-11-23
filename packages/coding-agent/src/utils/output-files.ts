/**
 * Output files: files pi writes so the model can use output it was not shown in full, such as the
 * full text of truncated tool output, binary MCP resources, and images shown by codemode scripts.
 * Every output file is created here, so where they are stored can change in one place. Today they
 * go to the OS temp directory.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Output can carry private data, so only the user may read the files. */
const OUTPUT_FILE_MODE = 0o600;

/** A new, unused path: `<dir>/<prefix>-<random hex><extension>`. `extension` includes the dot. */
function createOutputFilePath(prefix: string, extension: string): string {
	return join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}${extension}`);
}

/** Write `data` to a new output file and return its path. */
export async function writeOutputFile(prefix: string, extension: string, data: string | Uint8Array): Promise<string> {
	const path = createOutputFilePath(prefix, extension);
	// `wx` never follows a link someone else placed at the path.
	await writeFile(path, data, { mode: OUTPUT_FILE_MODE, flag: "wx" });
	return path;
}

/** Where streamed output ended up: a complete file, or why it could not be saved. */
export type OutputFileResult = { kind: "saved"; path: string } | { kind: "failed"; error: string };

/**
 * An output file written while output streams in. Open and write failures (full disk, quota, unwritable
 * temp dir) never throw: they arrive later as stream events, and an unhandled one would crash the
 * process. The first failure drops the file instead, and `close()` reports why.
 */
export interface OutputFileStream {
	/** Path of the file being written. Only complete once `close()` returns `saved`. */
	readonly path: string;
	/** Why writing failed, once it has. */
	readonly error: string | undefined;
	write(data: string | Uint8Array): void;
	/** Flush and close the file. Never rejects. */
	close(): Promise<OutputFileResult>;
}

/** Open a new output file for streamed output. */
export function createOutputFileStream(prefix: string, extension: string): OutputFileStream {
	const path = createOutputFilePath(prefix, extension);
	const stream: WriteStream = createWriteStream(path, { mode: OUTPUT_FILE_MODE, flags: "wx" });
	let error: string | undefined;
	let opened = false;
	let removed: Promise<void> | undefined;
	stream.once("open", () => {
		opened = true;
	});
	const finished = new Promise<void>((resolve) => {
		stream.once("finish", resolve);
		stream.on("error", (cause) => {
			error ??= cause.message;
			// A partial file would pass for the full output. A failed open (`wx` found a file) leaves
			// the path alone: whatever is there is not ours.
			if (opened) removed ??= rm(path, { force: true }).catch(() => {});
			resolve();
		});
	});
	return {
		path,
		get error() {
			return error;
		},
		write(data) {
			if (error === undefined && !stream.destroyed) stream.write(data);
		},
		async close() {
			// A stream destroyed by an error never emits `finish` after `end()`; `finished` already settled.
			if (!stream.destroyed) stream.end();
			await finished;
			await removed;
			return error === undefined ? { kind: "saved", path } : { kind: "failed", error };
		},
	};
}
