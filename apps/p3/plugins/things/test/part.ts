// For the tests of a kind's harness part (`testPlugin` of its worker facet): the part as the facet contributed it,
// stand-ins for what the harness hands it (a held thing, the session), and a tool run as the agent would run it.

import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, type P3Principal } from "@earendil-works/p3/v1";
import type { TestedPlugin } from "@earendil-works/p3/v1/testing";
import {
	type HarnessExtension,
	type HarnessSession,
	type HeldThing,
	type ThingHarnessPart,
	ThingHarnessParts,
} from "../contract.worker.ts";

/** A session whose `call` no case reaches, working nowhere. */
export const SESSION: HarnessSession = {
	session: "s",
	workspace: "w",
	call: () => Promise.reject(new Error("no call")),
	location: async () => undefined,
};

/** `Kind`'s harness part, as the tested worker facet `t` contributed it. */
export function partOf(t: TestedPlugin<P3Principal>, Kind: { readonly name: string }): ThingHarnessPart["part"] {
	const entry = t.contributions(ThingHarnessParts).find(({ value }) => value.kind.name === Kind.name);
	assert.ok(entry !== undefined, `no part of ${Kind.name}`);
	return entry.value.part;
}

/**
 * A held thing `thing` whose reference has `granted` and `members`, the ones its part reads (a state member is any
 * `{ value }`): a stand-in for the holding's reference, with nothing of a reference's lifecycle.
 */
export function held(thing: string, granted: readonly string[], members: object = {}): HeldThing {
	return {
		thing,
		workspace: "w",
		depth: 0,
		ref: { ...members, granted: new Set(granted) } as unknown as HeldThing["ref"],
		granted: new Set(granted),
	};
}

/** Runs tool `name` of `extension` with `args` (a tool that uses nothing of Durable's execution API); its text. */
export async function runTool(extension: HarnessExtension | undefined, name: string, args: object): Promise<string> {
	const tool = extension?.tools?.find((each) => each.name === name);
	assert.ok(tool !== undefined, name);
	const result = await tool.execute(args as never, {} as never, BACKGROUND_CONTEXT);
	// A park has no output.
	return (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}
