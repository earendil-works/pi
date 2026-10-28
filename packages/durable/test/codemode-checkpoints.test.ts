import { describe, expect, it } from "vitest";
import { CodemodeJournalDoc, CodemodeRunDoc, CodemodeStoreDoc } from "../src/codemode/codemode.ts";
import { NestedCallDoc } from "../src/harness/tool.ts";
import { context, createConversation, openTestSession } from "./session-support.ts";

describe("built-in document checkpoint policies", () => {
	it("keeps task-scoped documents as deltas until their task retires", () => {
		const info = { deltasSinceBase: 1000 };
		expect(NestedCallDoc.definition.checkpointWhen({}, [], info)).toBe(false);
		expect(CodemodeRunDoc.definition.checkpointWhen({}, [], info)).toBe(false);
		expect(CodemodeJournalDoc.definition.checkpointWhen({ entries: [] }, [], info)).toBe(false);
	});

	it("checkpoints the codemode store after 64 deltas without changing historical reads or forks", async () => {
		const { session, storage } = openTestSession();
		try {
			const conversationId = await createConversation(session);
			let cutoff = await session.commit(async (tx) => {
				(await tx.doc(CodemodeStoreDoc, conversationId)).values.counter = 0;
				return (await tx.appendEntry(conversationId, { kind: "test.counter" })).id;
			}, context);
			const record = await storage.findDocument(
				{ kind: CodemodeStoreDoc.definition.kind, scope: { kind: "conversation", conversationId } },
				"current",
				context,
			);
			if (record === undefined) throw new Error("Expected codemode store");
			for (let counter = 1; counter <= 64; counter++) {
				const entry = await session.commit(async (tx) => {
					(await tx.doc(CodemodeStoreDoc, conversationId)).values.counter = counter;
					return (await tx.appendEntry(conversationId, { kind: "test.counter" })).id;
				}, context);
				if (counter === 32) cutoff = entry;
			}
			expect((await storage.document(record.id, "current", context))?.deltasSinceBase).toBe(64);
			await session.commit(async (tx) => {
				(await tx.doc(CodemodeStoreDoc, conversationId)).values.counter = 65;
			}, context);
			expect((await storage.document(record.id, "current", context))?.deltasSinceBase).toBe(0);
			expect(storage.commits.at(-1)).toContainEqual({
				type: "document.change",
				id: record.id,
				content: { kind: "base", version: 1, value: { values: { counter: 65 } } },
			});
			expect(await session.snapshotAsOf(CodemodeStoreDoc, conversationId, cutoff, context)).toEqual({
				values: { counter: 32 },
			});
			const fork = await session.commit(
				(tx) => tx.forkConversation(conversationId, cutoff, { ownership: { kind: "ownerless" } }),
				context,
			);
			expect(await session.snapshot(CodemodeStoreDoc, fork.id, context)).toEqual({ values: { counter: 32 } });
			await session.commit(async (tx) => {
				(await tx.doc(CodemodeStoreDoc, conversationId)).values.counter = 66;
			}, context);
			expect((await storage.document(record.id, "current", context))?.deltasSinceBase).toBe(1);
		} finally {
			await session.close(context);
		}
	});
});
