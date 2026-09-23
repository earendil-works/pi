import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../src/storage/memory.ts";
import { ROOT_CONVERSATION_ID } from "../src/types.ts";

registerStorageConformance({ describe, expect, it }, "MemoryStorage", (use) => use(new MemoryStorage()));

it("does not expose retained state through a prepared commit", async () => {
	const storage = new MemoryStorage();
	await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
	const prepared = storage.prepareCommit([
		{
			type: "entry",
			value: {
				id: 2,
				conversationId: ROOT_CONVERSATION_ID,
				kind: "test",
				data: { nested: [1] },
			},
		},
	]);
	const exposed = prepared.writes[0];
	if (exposed.type !== "entry") throw new Error("Expected an entry write");
	expect(() => (exposed.value.data as { nested: number[] }).nested.push(2)).toThrow();

	expect(prepared.apply()).toBe(2);
	expect(prepared.apply()).toBe(2);
	expect((await storage.entry(2, BACKGROUND_CONTEXT))?.entry.data).toEqual({ nested: [1] });
});
