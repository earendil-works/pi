// The prompt store (`PromptStore`) on its own: instructions' settings merge (a setting left out keeps its value, the
// default where never set), also with two writes at once; a set's folder is refused outside the skills root, with its
// message; each clear removes one thing's settings only, and may run again. The plans of its queries are in
// `apps/p3/test/plans.test.ts`.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, type Reference } from "@earendil-works/p3/v1";
import { refused } from "../../things/test/kind-server.ts";
import { type Instructions, InstructionsKind } from "../instructions-kind.ts";
import { PromptStore } from "../store.ts";
import { type PromptServer, promptKind } from "./prompt-server.ts";

let n: PromptServer<typeof Instructions>;
let store: Reference<typeof PromptStore>;

beforeEach(async () => {
	n = await promptKind(InstructionsKind, context);
	store = await n.host.get(PromptStore, {}, context);
});

afterEach(async () => {
	store.release();
	await n.close();
});

/** Instructions `thing`'s stored settings, `undefined` while never set. */
const instructionsOf = async (thing: string) => (await store.instructions.of.page({ thing }, 1, context)).items[0];

describe("instructions' settings", () => {
	it("merge: a setting left out keeps its value, the default where never set", async () => {
		await store.configureInstructions({ thing: "a", language: "fr" }, context);
		assert.deepEqual(await instructionsOf("a"), { text: "", language: "fr" });
		await store.configureInstructions({ thing: "a", text: "Sois bref." }, context);
		assert.deepEqual(await instructionsOf("a"), { text: "Sois bref.", language: "fr" });
	});

	it("keep both of two writes at once", async () => {
		await Promise.all([
			store.configureInstructions({ thing: "a", language: "de" }, context),
			store.configureInstructions({ thing: "a", text: "Kurz." }, context),
		]);
		assert.deepEqual(await instructionsOf("a"), { text: "Kurz.", language: "de" });
	});

	it("are cleared for one thing only, and the clear may run again", async () => {
		await store.configureInstructions({ thing: "a", text: "A" }, context);
		await store.configureInstructions({ thing: "b", text: "B" }, context);
		await store.clearInstructions({ thing: "a" }, context);
		await store.clearInstructions({ thing: "a" }, context);
		assert.equal(await instructionsOf("a"), undefined);
		assert.equal((await instructionsOf("b"))?.text, "B");
	});
});

describe("a set's folder", () => {
	/** Set `thing`'s stored folder, `undefined` while never set. */
	const folderOf = async (thing: string) => (await store.skills.of.page({ thing }, 1, context)).items[0]?.folder;

	it("is refused outside the skills root with its message, and kept under it", async () => {
		for (const outside of ["/etc", "..", "../other", "coding/../../x"]) {
			await refused(store.configureSkills({ thing: "a", folder: outside }, context), "invalid", "outsideRoot");
		}
		assert.equal(await folderOf("a"), undefined);
		await store.configureSkills({ thing: "a", folder: "coding/../family" }, context);
		assert.equal(await folderOf("a"), "coding/../family");
	});

	it("is cleared for one thing only, and the clear may run again", async () => {
		await store.configureSkills({ thing: "a", folder: "x" }, context);
		await store.configureSkills({ thing: "b", folder: "y" }, context);
		await store.clearSkills({ thing: "a" }, context);
		await store.clearSkills({ thing: "a" }, context);
		assert.deepEqual([await folderOf("a"), await folderOf("b")], [undefined, "y"]);
	});
});
