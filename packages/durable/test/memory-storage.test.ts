import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { idFromNumber, seqFromNumber } from "../src/ids.ts";
import { MemoryStorage } from "../src/storage/memory.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";
import { type EntryId, ROOT_CONVERSATION_ID, type Seq, type StorageWrite } from "../src/types.ts";

registerStorageConformance({ describe, expect, it }, "MemoryStorage", (use) => use(new MemoryStorage()));

it("does not expose retained state through a prepared commit", async () => {
	const storage = new MemoryStorage();
	await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
	const entryId = idFromNumber<EntryId>(2);
	const prepared = storage.prepareCommit([
		{
			type: "entry",
			value: {
				id: entryId,
				conversationId: ROOT_CONVERSATION_ID,
				kind: "test",
				data: { nested: [1] },
			},
		},
	]);
	const exposed = prepared.writes[0];
	if (exposed.type !== "entry") throw new Error("Expected an entry write");
	expect(() => (exposed.value.data as { nested: number[] }).nested.push(2)).toThrow();

	expect(prepared.apply()).toBe(seqFromNumber(2));
	expect(prepared.apply()).toBe(seqFromNumber(2));
	expect((await storage.entry(entryId, BACKGROUND_CONTEXT))?.entry.data).toEqual({ nested: [1] });
});

it("delivers the receipts of the batches applied before one whose apply throws, then rejects", async () => {
	const failure = new Error("apply failed");
	class FailingApply extends MemoryStorage {
		failAt: Seq | undefined;
		override prepareCommit(writes: readonly StorageWrite[], seq?: Seq) {
			const prepared = super.prepareCommit(writes, seq);
			if (prepared.seq !== this.failAt) return prepared;
			return {
				...prepared,
				apply: (): Seq => {
					throw failure;
				},
			};
		}
	}
	const storage = new FailingApply();
	const root = await commitWrites(
		storage,
		[{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
		BACKGROUND_CONTEXT,
	);
	const [first, second] = [await storage.mintId<EntryId>(), await storage.mintId<EntryId>()];
	storage.failAt = seqFromNumber(root + 2);
	const receipts: [number, Seq][] = [];
	await expect(
		storage.commit(
			[first, second].map((id) => [
				{ type: "entry", value: { id, conversationId: ROOT_CONVERSATION_ID, kind: "m" } },
			]),
			(index, seq) => receipts.push([index, seq]),
			BACKGROUND_CONTEXT,
		),
	).rejects.toBe(failure);
	expect(receipts).toEqual([[0, root + 1]]);
	expect((await storage.entry(first, BACKGROUND_CONTEXT))?.commitSeq).toBe(root + 1);
	expect(await storage.entry(second, BACKGROUND_CONTEXT)).toBeUndefined();
});
