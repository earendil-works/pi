import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import {
	decodeLogLines,
	decodeSnapshot,
	encodeLogLine,
	encodeSnapshot,
	LOG_START,
	LogFormatError,
	readOutbox,
} from "../src/sync/index.ts";
import { type EntryId, ROOT_CONVERSATION_ID } from "../src/types.ts";
import { commitAll, sessionStore } from "./sync-support.ts";

const context = BACKGROUND_CONTEXT;

async function seeded() {
	const store = await sessionStore();
	await commitAll(store, [
		[{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
		[
			{
				type: "entry",
				value: { id: idFromNumber<EntryId>(2), conversationId: ROOT_CONVERSATION_ID, kind: "message", data: {} },
			},
		],
	]);
	return store;
}

describe("log lines", () => {
	it("round-trips outbox commits", async () => {
		const store = await seeded();
		try {
			const commits = await readOutbox(store, LOG_START, 100, context);
			// The storage's table declarations, then the two commits.
			expect(commits.length).toBe(3);
			expect(decodeLogLines(commits.map(encodeLogLine).join(""))).toEqual({ commits, torn: 0 });
		} finally {
			await store.close(context);
		}
	});

	it("reports a torn last line instead of failing", () => {
		const line = encodeLogLine({ seq: 1, nextId: 2, writes: [] });
		expect(decodeLogLines(line + line.slice(0, 5).replace('"seq":1', '"seq":2'))).toEqual({
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
