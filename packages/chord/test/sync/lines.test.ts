// The sync wire format: outbox commits as versioned JSON lines, and snapshots as store archives.
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { createDocument } from "../../src/store/engine.ts";
import type { ChordStore } from "../../src/store/store.ts";
import {
	decodeLogLines,
	decodeSnapshot,
	encodeLogLine,
	encodeSnapshot,
	LOG_START,
	LogFormatError,
	readOutbox,
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

describe("log lines", () => {
	it("round-trips outbox commits", async () => {
		const store = await seeded();
		try {
			const commits = await readOutbox(store, LOG_START, 100, context);
			expect(commits).toHaveLength(2);
			expect(decodeLogLines(commits.map(encodeLogLine).join(""))).toEqual({ commits, torn: 0 });
		} finally {
			await store.close(context);
		}
	});

	it("reports a torn last line instead of failing", () => {
		const line = encodeLogLine({ seq: 1, nextId: 2, writes: [] });
		expect(decodeLogLines(line + line.slice(0, 5))).toEqual({
			commits: [{ seq: 1, nextId: 2, writes: [] }],
			torn: 5,
		});
	});

	it("refuses unknown versions, a missing next id, and sequences that do not increase", () => {
		expect(() => decodeLogLines('{"v":1,"seq":1,"nextId":2,"writes":[]}\n')).toThrow(LogFormatError);
		expect(() => decodeLogLines('{"v":2,"seq":1,"writes":[]}\n')).toThrow(LogFormatError);
		const line = encodeLogLine({ seq: 3, nextId: 4, writes: [] });
		expect(() => decodeLogLines(line + line)).toThrow("does not increase");
	});
});

describe("snapshots", () => {
	it("round-trip a store archive", async () => {
		const store = await seeded();
		try {
			const parts: unknown[] = [];
			for await (const part of store.export(context)) parts.push(part);
			expect(await decodeSnapshot(await encodeSnapshot(store.export(context)))).toEqual(parts);
			expect(parts[0]).toMatchObject({ kind: "manifest", lastSeq: store.lastSeq });
		} finally {
			await store.close(context);
		}
	});
});
