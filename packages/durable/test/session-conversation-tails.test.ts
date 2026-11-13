import { describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { ConversationTails, type HeadMarker } from "../src/session/conversation-tails.ts";
import type { ConversationId, EntryId, EntryRecord, StorageWrite } from "../src/types.ts";

const conversation = (id: number) => idFromNumber<ConversationId>(id);
const entryId = (id: number) => idFromNumber<EntryId>(id);

function entry(id: number, conversationId: number, head?: number): StorageWrite {
	const value: EntryRecord = {
		id: entryId(id),
		conversationId: conversation(conversationId),
		kind: "note",
		...(head === undefined ? {} : { head: entryId(head) }),
	};
	return { type: "entry", value };
}

const never = (): Promise<never> => Promise.reject(new Error("read"));

describe("conversation tails", () => {
	it("reads once, then follows the commits", async () => {
		const tails = new ConversationTails();
		let reads = 0;
		const read = async () => {
			reads++;
			return entryId(5);
		};
		expect(await tails.latest(conversation(1), read)).toBe(5);
		expect(await tails.latest(conversation(1), read)).toBe(5);
		expect(reads).toBe(1);
		tails.apply([entry(9, 1)]);
		expect(await tails.latest(conversation(1), never)).toBe(9);
	});

	it("knows a new root conversation is empty, and a fork only once read or written", async () => {
		const tails = new ConversationTails();
		tails.apply([
			{ type: "conversation", value: { id: conversation(2) } },
			{
				type: "conversation",
				value: { id: conversation(3), parent: { conversationId: conversation(2), at: entryId(4) } },
			},
		]);
		expect(await tails.latest(conversation(2), never)).toBeUndefined();
		expect(await tails.marker(conversation(2), undefined, never)).toBeUndefined();
		expect(await tails.latest(conversation(3), async () => entryId(4))).toBe(4);
	});

	it("answers a cutoff from the newest marker only at or after it", async () => {
		const tails = new ConversationTails();
		tails.apply([{ type: "conversation", value: { id: conversation(1) } }, entry(10, 1), entry(11, 1, 10)]);
		const marker = (await tails.marker(conversation(1), undefined, never)) as HeadMarker;
		expect(marker.id).toBe(11);
		expect((await tails.marker(conversation(1), entryId(12), never))?.id).toBe(11);
		// An older cutoff may have an older marker: read, and not kept.
		let reads = 0;
		const older = async () => {
			reads++;
			return undefined;
		};
		expect(await tails.marker(conversation(1), entryId(10), older)).toBeUndefined();
		expect(await tails.marker(conversation(1), entryId(10), older)).toBeUndefined();
		expect(reads).toBe(2);
		expect((await tails.marker(conversation(1), undefined, never))?.id).toBe(11);
	});

	it("keeps a bounded number of conversations, fewer with markers", () => {
		const tails = new ConversationTails();
		for (let id = 1; id <= 5000; id++) tails.apply([entry(2 * id, id), entry(2 * id + 1, id, 2 * id)]);
		expect(tails.size).toBe(4096);
		expect(tails.markers).toBe(256);
	});

	it("freezes the markers it keeps", () => {
		const tails = new ConversationTails();
		const write = entry(2, 1, 1);
		tails.apply([write]);
		expect(Object.isFrozen((write as { value: object }).value)).toBe(true);
	});
});
