// What the harness gives the agent from what it holds (`AgentParts`) on its own (Astra, round 1): the previous held
// list and its part are collected once replaced; an apply with the same held map and parts walks nothing.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collected } from "../../../test/until.ts";
import { type Held, type HeldThing, thingHarnessPart } from "../../things/contract.worker.ts";
import { defineThing } from "../../things/kind.ts";
import { SESSION } from "../../things/test/part.ts";
import { AgentParts, type Parts } from "../agent-parts.ts";

/** A kind whose part gives one prompt section naming its first thing. */
const part = thingHarnessPart(defineThing("test.sample", { version: 1, ticks: {} }), ([held]) => ({
	extension: { sections: [{ key: "x", render: () => held?.thing }] },
}));

/** The parts: the sample kind's only. */
const parts: Parts = new Map([["test.sample", { plugin: "test", type: "test", value: part }]]);

/** A held thing whose reference nothing reads. */
function hold(): HeldThing {
	return { workspace: "s", thing: "one", ref: {} as never };
}

describe("the agent's parts", () => {
	it("let the previous held list and its part be collected", async () => {
		const agent = new AgentParts(SESSION);
		const refs = (() => {
			const things = [hold()];
			const copy = { ...part };
			agent.apply(
				new Map([["test.sample", things]]),
				new Map([["test.sample", { plugin: "test", type: "test", value: copy }]]),
			);
			return [new WeakRef(things), new WeakRef(copy)];
		})();
		agent.apply(new Map([["test.sample", [hold()]]]), parts);
		assert.ok(await collected(refs));
		assert.equal(agent.registry.snapshot().installed().length, 1);
	});

	it("walk nothing for an apply with the same held map and parts", () => {
		let visits = 0;
		class Counted extends Map<string, readonly HeldThing[]> {
			override [Symbol.iterator]() {
				visits++;
				return super[Symbol.iterator]();
			}
		}
		const held: Held = new Counted([["test.sample", [hold()]]]);
		const agent = new AgentParts(SESSION);
		agent.apply(held, parts);
		visits = 0;
		for (let i = 0; i < 100; i++) agent.apply(held, parts);
		assert.equal(visits, 0);
	});
});
