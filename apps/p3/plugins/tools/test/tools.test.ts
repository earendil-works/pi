// The tools plugin alone (`testPlugin`): its server facet registers the coding tools as a kind of thing (`ThingKinds`:
// four flag ticks for agents, all four for the agents by default, made by the plugin, nearest stacking); its worker
// facet's harness part gives Durable's coding tools whose flag the nearest reference has.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import { testPlugin } from "@earendil-works/p3/v1/testing";
import { type HeldThing, ThingHarnessParts } from "../../things/contract.worker.ts";
import { ThingKinds } from "../../things/kind.ts";
import { CodingToolsKind } from "../contract.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session, whose `call` the coding tools never use. */
const SESSION = {
	session: "s",
	workspace: "w",
	call: () => Promise.reject(new Error("no call")),
	location: async () => undefined,
};

/** A held coding tools thing whose reference has the flags `granted`. */
function held(thing: string, ...granted: string[]): HeldThing {
	// A stand-in for the holding's reference: the coding tools' part reads only `granted`.
	return { thing, workspace: "w", ref: { granted: new Set(granted) } as unknown as HeldThing["ref"] };
}

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

	it("gives each coding tool while its flag is granted on the nearest thing", async () => {
		const t = await testPlugin(ROOT, { kind: "worker", session: "s" }, context);
		try {
			const [entry] = t.contributions(ThingHarnessParts);
			assert.equal(entry?.value.kind.name, CodingToolsKind.name);
			const tools = (...things: HeldThing[]) =>
				entry.value
					.part(things, SESSION)
					.extension?.tools?.map((tool) => tool.name)
					.toSorted();
			assert.deepEqual(tools(held("t", "read", "write", "edit", "bash")), ["bash", "edit", "read", "write"]);
			// Bash withheld: the rest stay.
			assert.deepEqual(tools(held("t", "read", "write", "edit")), ["edit", "read", "write"]);
			assert.deepEqual(tools(held("t", "read")), ["read"]);
			// Let in with no flag: no extension at all.
			assert.equal(entry.value.part([held("t")], SESSION).extension, undefined);
			// Two links: the nearest (last) decides, the farther one's flags do not add up.
			assert.deepEqual(tools(held("pi", "read", "write", "edit", "bash"), held("team", "read")), ["read"]);
		} finally {
			await t.close(context);
		}
	});
});
