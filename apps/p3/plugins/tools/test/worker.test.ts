// The tools plugin's worker facet (`testPlugin`): its harness part, taken from the facet, gives Durable's coding tools
// whose flag the nearest coding tools thing has (`stacking: "nearest"`: the farther links' flags do not add up), and
// nothing when it has none. A tool withheld while a call runs is the harness's test (the call finishes).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import { testPlugin } from "@earendil-works/p3/v1/testing";
import { type HeldThing, ThingHarnessParts } from "../../things/contract.worker.ts";
import { CodingToolsKind } from "../kind.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session, whose `call` and `location` the coding tools never use. */
const SESSION = {
	session: "s",
	workspace: "w",
	call: () => Promise.reject(new Error("no call")),
	location: async () => undefined,
};

/** A held coding tools thing whose reference has the flags `granted`. */
function held(thing: string, ...granted: string[]): HeldThing {
	// A stand-in for the holding's reference until `kindServer.giving` is on main: the part reads only `granted`.
	return { thing, workspace: "w", depth: 0, ref: { granted: new Set(granted) } as unknown as HeldThing["ref"] };
}

describe("the coding tools' harness part", () => {
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
