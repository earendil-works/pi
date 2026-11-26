// The checklist plugin on a session's worker (`testPlugin`), beside a stand-in server serving `Checklist` with the
// admission a case sets: the session's checklists give the agent `checklist_list` and `checklist_read` always and
// `checklist_add` and `checklist_tick` only while one of them lets it tick; the tools reach the server's checklist through the agent's
// `call`, as the session's worker; a tick in a checklist that does not allow it, in an id that is no checklist, or one
// the server's admission no longer allows (options changed meanwhile) fails.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	allow,
	constant,
	BACKGROUND_CONTEXT as context,
	defineFacet,
	isChordError,
	type P3Principal,
} from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { type Agent, type Extension, ThingExtensions } from "@earendil-works/p3/v1/worker";
import { Checklist, type Item } from "../contract.ts";

const SESSION = "s1";

/** What the stand-in server admits callers of `Checklist` with; a case changes it before the call. */
let admitted = { access: "write" as "read" | "write", options: { check: true } };

/** The stand-in checklist's items, and the principals that held `Checklist`. */
let items: Item[] = [];
const holders: P3Principal["kind"][] = [];

/** A stand-in server: `Checklist` over `items`, admitting as `admitted` says. */
const standIn = defineFacet((host) => {
	host.serve(
		Checklist,
		(_params, principal, { access, options }, self) => {
			holders.push(principal.kind);
			const shown = self.writable(items);
			const reader = { items: self.derive([shown], ([value]) => [...value]) };
			if (access === "read" || !options.check) return { variant: "reader", members: reader };
			return {
				variant: "checker",
				members: {
					...reader,
					add: async ({ text }) => {
						items = [...items, { id: "i9", text, done: false }];
						shown.set(items);
						return "i9";
					},
					tick: async ({ id, done }) => {
						items = items.map((item) => (item.id === id ? { ...item, done } : item));
						shown.set(items);
						return null;
					},
				},
			};
		},
		{ admit: () => constant(allow(admitted)) },
	);
});

let t: TestedPlugin<P3Principal>;

beforeEach(async () => {
	items = [
		{ id: "i1", text: "milk", done: false },
		{ id: "i2", text: "bread", done: true },
	];
	holders.length = 0;
	admitted = { access: "write", options: { check: true } };
	t = await testPlugin(
		fileURLToPath(new URL("../", import.meta.url)),
		{ kind: "worker", session: SESSION, server: [{ name: "test.server", facet: standIn }] },
		context,
	);
});

afterEach(() => t.close(context));

/** The extension the kind gives the session's checklists `c1` ("Groceries") and `c2` ("Chores") with their `check`s. */
function gift(groceries: boolean, chores = false): Extension {
	const [entry] = t.contributions(ThingExtensions);
	assert.equal(entry?.value.kind.name, "checklist.checklist");
	const agent: Agent = { session: SESSION, call: (fn, ctx) => t.root(fn, ctx) };
	const lists = [
		{ thing: "c1", name: "Groceries", options: { check: groceries } },
		{ thing: "c2", name: "Chores", options: { check: chores } },
	];
	const given = entry.value.give(lists, agent);
	assert.ok(given.extension !== undefined);
	return given.extension;
}

/** Runs tool `name` of `extension` with `args`; its output's text. */
async function run(extension: Extension, name: string, args: object): Promise<string> {
	const tool = extension.tools?.find((each) => each.name === name);
	assert.ok(tool !== undefined, name);
	// The checklist tools use neither Durable's execution API nor arguments beyond their schema's.
	const result = await tool.execute(args as never, {} as never, context);
	// A park has no output: the checklist tools never park.
	return (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("what a checklist gives the agent", () => {
	it("offers checklist_add and checklist_tick only while one of the checklists lets the agent tick", () => {
		const names = (extension: Extension) => extension.tools?.map(({ name }) => name);
		const all = ["checklist_list", "checklist_read", "checklist_add", "checklist_tick"];
		assert.deepEqual(names(gift(true)), all);
		assert.deepEqual(names(gift(false, true)), all);
		assert.deepEqual(names(gift(false)), ["checklist_list", "checklist_read"]);
	});

	it("lists the checklists by id and name, with whether the agent may tick there", async () => {
		assert.deepEqual(JSON.parse(await run(gift(true), "checklist_list", {})), [
			{ id: "c1", name: "Groceries", tick: true },
			{ id: "c2", name: "Chores", tick: false },
		]);
	});

	it("reads the items with their ids, and ticks one, as the session's worker", async () => {
		const extension = gift(true);
		assert.deepEqual(JSON.parse(await run(extension, "checklist_read", { checklist: "c1" })), items);
		assert.equal(await run(extension, "checklist_tick", { checklist: "c1", item: "i1", done: true }), "Ticked i1.");
		assert.deepEqual(
			items.map(({ done }) => done),
			[true, true],
		);
		assert.deepEqual([...new Set(holders)], ["worker"]);
	});

	it("adds an item and answers its id; refuses an add in a checklist that does not allow it", async () => {
		const extension = gift(true);
		assert.equal(await run(extension, "checklist_add", { checklist: "c1", text: "eggs" }), "Added i9.");
		assert.deepEqual(items.at(-1), { id: "i9", text: "eggs", done: false });
		await assert.rejects(
			run(extension, "checklist_add", { checklist: "c2", text: "dust" }),
			(error: unknown) => isChordError(error) && error.code === "forbidden" && /"Chores" \(c2\)/.test(error.message),
		);
		assert.equal(items.length, 3);
	});

	it("fails a tick in a checklist that does not allow it, and in an id that is no checklist, naming it", async () => {
		const extension = gift(true);
		await assert.rejects(
			run(extension, "checklist_tick", { checklist: "c2", item: "i1", done: true }),
			(error: unknown) => isChordError(error) && error.code === "forbidden" && /"Chores" \(c2\)/.test(error.message),
		);
		await assert.rejects(
			run(extension, "checklist_tick", { checklist: "c9", item: "i1", done: true }),
			/no checklist "c9"/,
		);
		assert.equal(items[0]?.done, false);
	});

	it("fails a tick the server no longer admits", async () => {
		const extension = gift(true);
		admitted = { ...admitted, options: { check: false } };
		await assert.rejects(
			run(extension, "checklist_tick", { checklist: "c1", item: "i1", done: true }),
			(error: unknown) => isChordError(error) && error.code === "forbidden",
		);
		assert.equal(items[0]?.done, false);
	});
});
