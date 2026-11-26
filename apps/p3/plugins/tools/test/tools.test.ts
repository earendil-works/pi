// The tools plugin alone (`testPlugin`): its server facet offers the coding tools as a kind of thing (`ThingKinds`),
// its worker facet gives the session's `tools.coding` things Durable's coding tools once, bash when one of them has
// `shell` on.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CodingTools, BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import { ThingKinds } from "@earendil-works/p3/v1/server";
import { testPlugin } from "@earendil-works/p3/v1/testing";
import { ThingExtensions } from "@earendil-works/p3/v1/worker";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

describe("the tools plugin", () => {
	it("offers the coding tools as a kind of thing on the server", async () => {
		const t = await testPlugin(ROOT, { kind: "server" }, context);
		try {
			const [entry] = t.contributions(ThingKinds);
			assert.equal(entry?.value.kind, CodingTools);
			assert.equal(entry?.value.title, "Coding tools");
		} finally {
			await t.close(context);
		}
	});

	it("gives read, write, edit and bash once, bash when a thing has shell on", async () => {
		const t = await testPlugin(ROOT, { kind: "worker", session: "s" }, context);
		try {
			const [entry] = t.contributions(ThingExtensions);
			assert.equal(entry?.value.kind, CodingTools);
			const agent = { session: "s", call: () => Promise.reject(new Error("no call")) };
			const tools = (...shells: boolean[]) =>
				entry?.value
					.give(
						shells.map((shell, at) => ({ thing: `t${at}`, name: "", options: { shell } })),
						agent,
					)
					.extension?.tools?.map((tool) => tool.name)
					.toSorted();
			assert.deepEqual(tools(true), ["bash", "edit", "read", "write"]);
			assert.deepEqual(tools(false), ["edit", "read", "write"]);
			// Two coding tools things give the tools once; one with a shell gives bash.
			assert.deepEqual(tools(false, true), ["bash", "edit", "read", "write"]);
			assert.deepEqual(tools(false, false), ["edit", "read", "write"]);
		} finally {
			await t.close(context);
		}
	});
});
