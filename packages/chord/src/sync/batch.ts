// Bodies on the remote, encoded and decoded as streams, so neither side holds a whole batch or snapshot in memory:
// gzip-compressed JSON lines, one outbox commit (a batch) or one archive part (a snapshot) per line. gzip, because
// `CompressionStream` offers it in Node, Workers, and browsers alike, and a browser viewer reads batches too.

import type { ArchivePart } from "../store/archive.ts";
import { decodeJsonl, encodeJsonl } from "../store/jsonl.ts";
import type { OutboxCommit } from "../store/outbox.ts";
import { decodeLogLine, encodeLogLine, LogFormatError } from "./lines.ts";

/** A body on the remote: its bytes in chunks, read once. */
export type SyncBody = AsyncIterable<Uint8Array>;

/** The bytes a chunk of encoded lines collects before it is compressed. */
const CHUNK = 64 * 1024;

/** A batch body: `commits` as gzip-compressed JSON lines, read from `commits` only as the body is read. */
export function encodeBatch(commits: Iterable<OutboxCommit> | AsyncIterable<OutboxCommit>): SyncBody {
	return encodeLines(
		(async function* () {
			for await (const commit of commits) yield encodeLogLine(commit);
		})(),
	);
}

/** The commits of a batch body, in order, as they arrive. */
export async function* decodeBatch(body: SyncBody): AsyncGenerator<OutboxCommit> {
	for await (const { commit } of decodeBatchLines(body)) yield commit;
}

/** The commits of a batch body with the size of each line, for callers that bound what they hold. */
export async function* decodeBatchLines(
	body: SyncBody,
): AsyncGenerator<{ readonly commit: OutboxCommit; readonly bytes: number }> {
	let previous = 0;
	for await (const { text, number } of lines(gunzip(body))) {
		const commit = decodeLogLine(text, number);
		if (commit.seq <= previous) throw new LogFormatError(`Log line ${number} does not increase the sequence`);
		previous = commit.seq;
		yield { commit, bytes: text.length + 1 };
	}
}

/** A snapshot body: a store archive (`store.export()`), one part per JSON line, gzip-compressed. */
export function encodeSnapshot(parts: AsyncIterable<ArchivePart>): SyncBody {
	return gzip(encodeJsonl(parts));
}

/** The parts of a snapshot body as they arrive, unchecked: `importStore()` checks them (a trust boundary). */
export function decodeSnapshot(body: SyncBody): AsyncIterable<unknown> {
	return decodeJsonl(gunzip(body));
}

/** Text lines, already newline-terminated, gzip-compressed in chunks of whole lines. */
function encodeLines(lines: AsyncIterable<string>): SyncBody {
	return gzip(
		(async function* () {
			const encoder = new TextEncoder();
			let pending = "";
			for await (const line of lines) {
				pending += line;
				if (pending.length >= CHUNK) {
					yield encoder.encode(pending);
					pending = "";
				}
			}
			if (pending.length > 0) yield encoder.encode(pending);
		})(),
	);
}

/** The lines of decompressed `chunks` without their newlines; a body that ends inside a line is an error. */
async function* lines(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<{ readonly text: string; number: number }> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let rest = "";
	let number = 0;
	const decode = (chunk?: Uint8Array): string => {
		try {
			return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true });
		} catch (error) {
			throw new LogFormatError(`Log line ${number + 1} is not UTF-8`, { cause: error });
		}
	};
	for await (const chunk of chunks) {
		rest += decode(chunk);
		let start = 0;
		for (let end = rest.indexOf("\n"); end >= 0; end = rest.indexOf("\n", start)) {
			yield { text: rest.slice(start, end), number: ++number };
			start = end + 1;
		}
		rest = rest.slice(start);
	}
	rest += decode();
	if (rest.length > 0) throw new LogFormatError(`The body ends inside log line ${number + 1}`);
}

function gzip(chunks: AsyncIterable<Uint8Array>): SyncBody {
	return pipe(chunks, new CompressionStream("gzip"));
}

function gunzip(chunks: SyncBody): AsyncIterable<Uint8Array> {
	return pipe(chunks, new DecompressionStream("gzip"));
}

/**
 * `chunks` through `transform`, as they come: the source is written while the output is read, so each holds no more
 * than the stream's buffers. Stopping early, or a failure on either side, ends the source too (its `return()`, which
 * for an export gives the store's commit queue back).
 */
async function* pipe(
	chunks: AsyncIterable<Uint8Array>,
	transform: CompressionStream | DecompressionStream,
): AsyncGenerator<Uint8Array> {
	const writer = transform.writable.getWriter();
	const reader = transform.readable.getReader();
	const writing = (async () => {
		try {
			for await (const chunk of chunks) await writer.write(chunk as Uint8Array<ArrayBuffer>);
			await writer.close();
		} catch (error) {
			await writer.abort(error).catch(() => {});
			throw error;
		}
	})();
	// Its failure reaches the reader too (the abort errors the readable side); this only keeps it from going unhandled.
	writing.catch(() => {});
	let done = false;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			yield result.value;
		}
		done = true;
		await writing;
	} finally {
		if (!done) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
