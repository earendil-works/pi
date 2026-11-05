// The sync wire format, as streams: outbox commits as versioned, gzip-compressed JSON lines, snapshots as store
// archives, and decoding that holds one line at a time.
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { createDocument } from "../../src/store/engine.ts";
import type { ChordStore } from "../../src/store/store.ts";
import {
	decodeBatch,
	decodeLogLine,
	decodeSnapshot,
	encodeBatch,
	encodeLogLine,
	encodeSnapshot,
	LOG_START,
	LogFormatError,
	readOutbox,
	type SyncBody,
} from "../../src/sync/index.ts";
import { memoryStore } from "../support.ts";

const OPEN = { admit: () => true, adopt: () => {} };

/** A store with its outbox on and two commits: two documents created one at a time. */
async function seeded(): Promise<ChordStore> {
	const store = await memoryStore({ outbox: true });
	for (const key of ["a", "b"]) {
		const base = { version: 1, fingerprint: "f1", value: { key } };
		await store.commit(
			[
				createDocument(
					{ namespace: "chord", owner: "app.sync", kind: "note", key },
					base,
					JSON.stringify(base.value),
				),
			],
			OPEN,
			context,
		);
	}
	return store;
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) out.push(item);
	return out;
}

/** A body's bytes, joined. */
async function bytesOf(body: SyncBody): Promise<Uint8Array> {
	const chunks = await collect(body);
	const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

/** Plain bytes gzip-compressed, as a body: for bodies the encoders would never write. */
function gzipped(text: string): SyncBody {
	return (async function* () {
		const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
		yield new Uint8Array(await new Response(stream).arrayBuffer());
	})();
}

/** `bytes` as a body of chunks of `size`: decoding must not depend on where chunks split. */
async function* chunked(bytes: Uint8Array, size: number): SyncBody {
	for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

describe("batch bodies", () => {
	it("round-trip outbox commits, whatever the chunks", async () => {
		const store = await seeded();
		try {
			const commits = await readOutbox(store, LOG_START, 100, context);
			expect(commits).toHaveLength(2);
			const bytes = await bytesOf(encodeBatch(commits));
			expect(bytes[0]).toBe(0x1f);
			for (const size of [1, 7, bytes.length]) {
				expect(await collect(decodeBatch(chunked(bytes, size)))).toEqual(commits);
			}
		} finally {
			await store.close(context);
		}
	});

	it("refuse a body that ends inside a line", async () => {
		const line = encodeLogLine({ seq: 1, nextId: 2, writes: [] });
		await expect(collect(decodeBatch(gzipped(line + line.slice(0, 5))))).rejects.toThrow("ends inside log line 2");
	});

	it("refuse sequences that do not increase", async () => {
		const line = encodeLogLine({ seq: 3, nextId: 4, writes: [] });
		await expect(collect(decodeBatch(gzipped(line + line)))).rejects.toThrow("does not increase");
	});

	it("decode a commit only when it is read", async () => {
		const lines = [1, 2, 3].map((seq) => encodeLogLine({ seq, nextId: seq + 1, writes: [] })).join("");
		const commits = decodeBatch(gzipped(`${lines}not json\n`));
		const iterator = commits[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toMatchObject({ seq: 1 });
		await iterator.return?.(undefined);
	});
});

describe("log lines", () => {
	it("refuse unknown versions and a missing next id", () => {
		expect(() => decodeLogLine('{"v":1,"seq":1,"nextId":2,"writes":[]}', 1)).toThrow(LogFormatError);
		expect(() => decodeLogLine('{"v":2,"seq":1,"writes":[]}', 1)).toThrow(LogFormatError);
		expect(decodeLogLine('{"v":2,"seq":1,"nextId":2,"writes":[]}', 1)).toEqual({ seq: 1, nextId: 2, writes: [] });
	});
});

describe("snapshot bodies", () => {
	it("round-trip a store archive", async () => {
		const store = await seeded();
		try {
			const parts = await collect(store.export(context));
			expect(await collect(decodeSnapshot(encodeSnapshot(store.export(context))))).toEqual(parts);
			expect(parts[0]).toMatchObject({ kind: "manifest", lastSeq: store.lastSeq });
		} finally {
			await store.close(context);
		}
	});

	it("give the store's commit queue back when the body is not read to the end", async () => {
		const store = await seeded();
		try {
			const body = encodeSnapshot(store.export(context))[Symbol.asyncIterator]();
			await body.next();
			await body.return?.();
			const base = { version: 1, fingerprint: "f1", value: { key: "c" } };
			const committed = store.commit(
				[createDocument({ namespace: "chord", owner: "app.sync", kind: "note", key: "c" }, base, "{}")],
				OPEN,
				context,
			);
			await expect(committed).resolves.toBeGreaterThan(0);
		} finally {
			await store.close(context);
		}
	});
});
