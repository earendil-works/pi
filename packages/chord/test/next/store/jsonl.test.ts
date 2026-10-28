// Tests of the JSONL archive encoding (slice 6a §13): parts as lines, chunks split anywhere (inside a line, inside a
// UTF-8 sequence), blank lines, and the refusal of a line that is no JSON.

import { describe, expect, it } from "vitest";
import type { ArchivePart } from "../../../src/next/store/archive.ts";
import { decodeJsonl, encodeJsonl } from "../../../src/next/store/jsonl.ts";
import { rejection } from "../support.ts";

async function* from<T>(values: readonly T[]): AsyncIterable<T> {
	yield* values;
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
	const all: T[] = [];
	for await (const value of values) all.push(value);
	return all;
}

const PARTS: ArchivePart[] = [
	{ kind: "manifest", format: 1, schema: 1, lastSeq: 3, nextId: 2 },
	{ kind: "put", table: "app.store:edits", row: { id: "ü€😀", n: 1 }, version: 1, columns: {} },
	{ kind: "end", writes: 1 },
];

describe("jsonl", () => {
	it("encodes one part per line and decodes it back, from chunks split anywhere", async () => {
		const bytes = Buffer.concat(await collect(encodeJsonl(from(PARTS))));
		expect(bytes.toString("utf8").split("\n")).toHaveLength(PARTS.length + 1);
		for (const size of [1, 2, 3, 7, bytes.length]) {
			const chunks: Uint8Array[] = [];
			for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
			expect(await collect(decodeJsonl(from(chunks)))).toEqual(PARTS);
		}
	});

	it("skips blank lines and takes a last line without a newline", async () => {
		const text = `\n${JSON.stringify(PARTS[0])}\n\n${JSON.stringify(PARTS[2])}`;
		expect(await collect(decodeJsonl(from([new TextEncoder().encode(text)])))).toEqual([PARTS[0], PARTS[2]]);
	});

	it("refuses a line that is no JSON, naming it", async () => {
		const text = `${JSON.stringify(PARTS[0])}\n{nope\n`;
		expect(await rejection(collect(decodeJsonl(from([new TextEncoder().encode(text)]))))).toMatchObject({
			code: "invalid",
			reason: "args",
			message: "jsonl: line 2 is not JSON",
		});
	});

	it("refuses bytes that are no UTF-8", async () => {
		expect(await rejection(collect(decodeJsonl(from([new Uint8Array([0x7b, 0xff, 0x0a])]))))).toMatchObject({
			code: "invalid",
			message: "jsonl: line 1 is not UTF-8",
		});
	});
});
