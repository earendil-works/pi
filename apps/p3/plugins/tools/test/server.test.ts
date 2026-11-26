// The tools plugin's server facet (`testPlugin`): it registers the coding tools as a kind of thing (`ThingKinds`):
// four flag ticks for agents, all four for the agents by default, made by the plugin, nearest stacking.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import { testPlugin } from "@earendil-works/p3/v1/testing";
import { ThingKinds } from "../../things/kind.ts";
import { CodingToolsKind } from "../kind.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

describe("the tools plugin", () => {
	it("registers the coding tools: four flag ticks for agents, all given to the agents, made by the plugin", async () => {
		const t = await testPlugin(ROOT, { kind: "server" }, context);
		try {
			const [entry] = t.contributions(ThingKinds);
			assert.equal(entry?.value.name, CodingToolsKind.name);
			assert.deepEqual(
				entry.value.ticks.map(({ name, for: forWhom }) => [name, forWhom]),
				[
					["read", "agents"],
					["write", "agents"],
					["edit", "agents"],
					["bash", "agents"],
				],
			);
			assert.deepEqual(entry.value.defaultGrants, { agents: ["read", "write", "edit", "bash"] });
			assert.equal(entry.value.makers, "plugin");
			assert.equal(entry.value.stacking, "nearest");
			// Flag ticks: each gives itself, a flag of its name, and no member.
			assert.deepEqual([...CodingToolsKind.all].toSorted(), ["bash", "edit", "read", "write"]);
		} finally {
			await t.close(context);
		}
	});
});
