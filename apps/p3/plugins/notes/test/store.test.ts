// The notes store (`NotesStore`) on its own: a note's `at` is unique in its notebook and the last written is the
// newest, also for writes within one millisecond and with the clock gone back (the notebook's pages are bounded by
// `at`); an edit makes a note the last written, by its editor; `clear` removes one notebook's notes only.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import { kindServer } from "../../things/test/kind-server.ts";
import { NotesKind } from "../contract.ts";
import { NotesStore } from "../store.ts";

/** A person as an author. */
const ANN = { kind: "person", person: "ann" } as const;

describe("the notes store", () => {
	it("gives each note a unique `at`, the last written newest, in one millisecond or the clock back", async (t) => {
		const n = await kindServer(fileURLToPath(new URL("../", import.meta.url)), NotesKind, context);
		try {
			const now = Date.now();
			const clock = t.mock.method(Date, "now", () => now);
			const store = await n.t.host.get(NotesStore, {}, context);
			const first = await store.add({ notebook: "a", text: "1", author: ANN }, context);
			await store.add({ notebook: "a", text: "2", author: ANN }, context);
			clock.mock.mockImplementation(() => now - 1000);
			await store.add({ notebook: "a", text: "3", author: ANN }, context);
			await store.edit(
				{ notebook: "a", id: first, text: "1 edited", author: { kind: "agent", session: "s1" } },
				context,
			);
			await store.add({ notebook: "b", text: "other", author: ANN }, context);
			const { items } = await store.notes.of.page({ notebook: "a" }, 10, context);
			assert.deepEqual(
				items.map(({ text, at }) => [text, at - now]),
				[
					["1 edited", 3],
					["3", 2],
					["2", 1],
				],
			);
			assert.deepEqual(items[0]?.author, { kind: "agent", session: "s1" });
			await store.clear({ notebook: "a" }, context);
			assert.deepEqual((await store.notes.of.page({ notebook: "a" }, 10, context)).items, []);
			assert.equal((await store.notes.of.page({ notebook: "b" }, 10, context)).items.length, 1);
		} finally {
			await n.close();
		}
	});
});
