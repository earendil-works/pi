// What the harness gives the agent from what it holds (`AgentParts`) on its own (Astra, round 1): the previous held
// list and its part are collected once replaced; an apply with the same held map and parts walks nothing; a `main`
// tool is installed guarded: called from a conversation a task owns (a subagent's), it refuses and runs nothing.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, isChordError, obj } from "@earendil-works/p3/v1";
import { defineTool } from "@earendil-works/p3/v1/worker";
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
	return { workspace: "s", thing: "one", depth: 0, ref: {} as never };
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

	it("installs a main tool guarded: a subagent's call refuses, the main conversation's runs", async () => {
		let runs = 0;
		const tool = defineTool({
			name: "test_main",
			description: "A main tool",
			parameters: obj({}),
			execute: async () => {
				runs++;
				return { output: [{ type: "text", text: "ran" }] };
			},
		});
		const scoped = thingHarnessPart(defineThing("test.scoped", { version: 1, ticks: {} }), () => ({
			extension: { tools: [{ ...tool, scope: "main" }] },
		}));
		const agent = new AgentParts(SESSION);
		agent.apply(new Map([["test.scoped", [hold()]]]), new Map([["test.scoped", { plugin: "test", value: scoped }]]));
		const installed = agent.registry.snapshot().tools()[0]?.tool;
		assert.ok(installed !== undefined);
		// The stand-in api gives what the guard reads: the calling conversation's record, owned by a task or not.
		const call = (owner?: object) => {
			const api = {
				conversationId: 2,
				commit: async (fn: (tx: unknown) => unknown) => fn({ conversation: async () => ({ id: 2, owner }) }),
			};
			return installed.execute({}, api as never, context);
		};
		await assert.rejects(
			call({ conversationId: 1, taskId: 5 }),
			(error) =>
				isChordError(error) && error.code === "forbidden" && /only in the session's main/.test(error.message),
		);
		assert.equal(runs, 0);
		await call();
		assert.equal(runs, 1);
	});
});
