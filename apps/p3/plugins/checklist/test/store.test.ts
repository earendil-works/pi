// The checklist store (`ChecklistStore`) on its own: items keep the order they were added in (`seq` numbered from 1,
// the count read from the last one, as items are never removed one by one); a checklist holds at most `MAX_ITEMS` and
// refuses the next with its message; a tick of an item the checklist does not have is refused; `clear` removes one
// checklist's items only, may run twice, and marks it gone, so a later add is refused.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import { kindServer, refused } from "../../things/test/kind-server.ts";
import { ChecklistKind, MAX_ITEMS } from "../kind.ts";
import checklistServer from "../server.ts";
import { ChecklistStore } from "../store.ts";

describe("the checklist store", () => {
	it("keeps the order items were added in, holds at most MAX_ITEMS, and clears a checklist for good", async () => {
		const root = fileURLToPath(new URL("../", import.meta.url));
		const c = await kindServer(
			{ name: "@earendil-works/p3-checklist", root, server: checklistServer },
			ChecklistKind,
			context,
		);
		try {
			const store = await c.host.get(ChecklistStore, {}, context);
			const items = async (checklist: string) =>
				(await store.items.of.page({ checklist }, MAX_ITEMS + 1, context)).items;
			const ids: string[] = [];
			for (let i = 0; i < MAX_ITEMS; i++) ids.push(await store.add({ checklist: "a", text: `i${i}` }, context));
			await store.add({ checklist: "b", text: "other" }, context);
			await refused(store.add({ checklist: "a", text: "one too many" }, context), "invalid", "full");
			const stored = await items("a");
			assert.deepEqual(
				stored.map(({ id }) => id),
				ids,
			);
			await store.tick({ checklist: "a", id: ids[1]!, done: true }, context);
			assert.deepEqual((await items("a"))[1], { id: ids[1], text: "i1", done: true });
			await refused(store.tick({ checklist: "a", id: "none", done: true }, context), "invalid", "noItem");
			await store.clear({ checklist: "a" }, context);
			await store.clear({ checklist: "a" }, context);
			assert.deepEqual(await items("a"), []);
			// Cleared, it is gone: an add that comes later (begun before the clear) is refused.
			await refused(store.add({ checklist: "a", text: "late" }, context), "invalid", "gone");
			assert.deepEqual(await items("a"), []);
			assert.deepEqual(
				(await items("b")).map(({ text }) => text),
				["other"],
			);
		} finally {
			await c.close();
		}
	});
});
