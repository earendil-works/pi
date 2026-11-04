import type { ArchivePart } from "../store/archive.ts";
import type { OutboxCommit } from "../store/outbox.ts";
import { decodeLogLines, encodeLogLine, LogFormatError } from "./lines.ts";

/**
 * A batch as uploaded: outbox commits after one sequence as gzip-compressed JSON lines. gzip, because
 * `CompressionStream` offers it in Node, Workers, and browsers alike, and a browser viewer reads batches too.
 */
export async function encodeBatch(commits: readonly OutboxCommit[]): Promise<Uint8Array> {
	return gzip(new TextEncoder().encode(commits.map(encodeLogLine).join("")));
}

export async function decodeBatch(bytes: Uint8Array): Promise<OutboxCommit[]> {
	const { commits, torn } = decodeLogLines(await gunzipText(bytes));
	if (torn > 0) throw new LogFormatError("Batch ends inside a log line");
	return commits;
}

/** A snapshot as uploaded: a store archive (`store.export()`), one part per JSON line, gzip-compressed. */
export async function encodeSnapshot(parts: AsyncIterable<ArchivePart>): Promise<Uint8Array> {
	let text = "";
	for await (const part of parts) text += `${JSON.stringify(part)}\n`;
	return gzip(new TextEncoder().encode(text));
}

/** The parts of a snapshot, unchecked: `importStore()` checks them (a trust boundary). */
export async function decodeSnapshot(bytes: Uint8Array): Promise<unknown[]> {
	const text = await gunzipText(bytes);
	if (text.length > 0 && !text.endsWith("\n")) throw new LogFormatError("Snapshot ends inside a line");
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line, index) => {
			try {
				return JSON.parse(line) as unknown;
			} catch (error) {
				throw new LogFormatError(`Snapshot line ${index + 1} is not JSON`, { cause: error });
			}
		});
}

function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	return transform(bytes, new CompressionStream("gzip"));
}

async function gunzipText(bytes: Uint8Array): Promise<string> {
	return new TextDecoder("utf-8", { fatal: true }).decode(await transform(bytes, new DecompressionStream("gzip")));
}

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
	const output = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
	return new Uint8Array(await new Response(output).arrayBuffer());
}
