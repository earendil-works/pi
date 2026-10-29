// Plain JSONL for archives (slice 6a §13): one part per line, UTF-8. The store yields and takes parts; this is the
// encoding it ships (others, compressed ones, come later without touching the applier).

import { invalid } from "../data/internal.ts";
import type { ArchivePart } from "./archive.ts";

/** The bytes a chunk of encoded lines collects before it is yielded. */
const CHUNK = 64 * 1024;

/** `parts` as JSONL bytes, in chunks of whole lines. */
export async function* encodeJsonl(parts: AsyncIterable<ArchivePart>): AsyncIterable<Uint8Array> {
	const encoder = new TextEncoder();
	let lines = "";
	for await (const part of parts) {
		lines += `${JSON.stringify(part)}\n`;
		if (lines.length >= CHUNK) {
			yield encoder.encode(lines);
			lines = "";
		}
	}
	if (lines.length > 0) yield encoder.encode(lines);
}

/**
 * The values of JSONL `bytes`, one per nonempty line, for `importStore` to check (a trust boundary: bytes that are
 * no UTF-8 and a line that is no JSON are `invalid/args`).
 */
export async function* decodeJsonl(bytes: AsyncIterable<Uint8Array>): AsyncIterable<unknown> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let rest = "";
	let line = 0;
	const parse = (text: string): unknown => {
		try {
			return JSON.parse(text);
		} catch {
			throw invalid("args", `jsonl: line ${line} is not JSON`);
		}
	};
	const decode = (chunk?: Uint8Array): string => {
		try {
			return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true });
		} catch {
			throw invalid("args", `jsonl: line ${line + 1} is not UTF-8`);
		}
	};
	for await (const chunk of bytes) {
		rest += decode(chunk);
		let start = 0;
		for (let end = rest.indexOf("\n"); end >= 0; end = rest.indexOf("\n", start)) {
			const text = rest.slice(start, end);
			start = end + 1;
			line++;
			if (text.trim().length > 0) yield parse(text);
		}
		rest = rest.slice(start);
	}
	rest += decode();
	line++;
	if (rest.trim().length > 0) yield parse(rest);
}
