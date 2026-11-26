// The machine kind's harness part, called as the harness calls it (stand-in references with their grants and info):
// a location on a held machine with Work here gets a Node environment in its folder; a machine held without Work
// here, or not held, gets none; the prompt line names the machine of the conversation's location (not the first one
// held) and the folder, or says no machine is available.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import type { HarnessSession, HeldThing } from "../../things/contract.worker.ts";
import { machinePart } from "../harness-part.ts";
import type { Machine } from "../kind.ts";

/** The session the part is called for: its conversations work on machine `machine`. */
function session(machine = "m1"): HarnessSession {
	return {
		session: "s",
		workspace: "w",
		call: () => Promise.reject(new Error("no call")),
		location: async () => ({ machine, folder: "/tmp" }),
	};
}

/** A held machine `thing` named `name` whose reference has the flags `granted`. */
function held(thing: string, name: string, ...granted: string[]): HeldThing<typeof Machine> {
	// A stand-in for the holding's reference: the part reads only `granted` and `info`.
	const ref = { granted: new Set(granted), info: { value: { name, status: "ready" } } };
	return { thing, workspace: "w", ref: ref as unknown as HeldThing<typeof Machine>["ref"] };
}

/** The part's contribution for `things`, as the harness gets it. */
const given = (...things: HeldThing<typeof Machine>[]) => machinePart.part(things, session());

/** The prompt line of `contribution` for environment `env`. */
async function line(contribution: ReturnType<typeof given>, env: { cwd: string } | undefined) {
	const [section] = contribution.prompt ?? [];
	// The section reads only `conversationId` and `env` of its input.
	return section?.render({ conversationId: 1, env } as never, context);
}

describe("the machine's harness part", () => {
	it("gives a Node environment in the folder of a location on a held machine with Work here", async () => {
		const contribution = given(held("m1", "slayer", "work"));
		const env = await contribution.env?.({ machine: "m1", folder: "/tmp" }, context);
		assert.equal(env?.cwd, "/tmp");
		assert.equal(await line(contribution, env), "Tools run on slayer, in /tmp.");
	});

	it("names the machine the conversation works on, not the first one held (opus nit)", async () => {
		const contribution = machinePart.part(
			[held("m1", "slayer", "work"), held("m2", "laptop", "work")],
			session("m2"),
		);
		const env = await contribution.env?.({ machine: "m2", folder: "/tmp" }, context);
		assert.equal(await line(contribution, env), "Tools run on laptop, in /tmp.");
	});

	it("gives none on a machine held without Work here, or not held", async () => {
		const contribution = given(held("m1", "slayer"));
		assert.equal(await contribution.env?.({ machine: "m1", folder: "/tmp" }, context), undefined);
		assert.equal(
			await given(held("m1", "slayer", "work")).env?.({ machine: "m2", folder: "/tmp" }, context),
			undefined,
		);
		assert.equal(await line(contribution, undefined), "No machine is available here: commands cannot run.");
	});
});
