// The checklist kind's harness part: the worker facet contributes it to `ThingHarnessParts`; given the checklists an
// agent holds (real references, held as the session's worker on a server with the things plugin), it offers
// `checklist_list` and `checklist_read` always and `checklist_add` and `checklist_tick` while one checklist gives
// Write; `checklist_list` names each checklist with its id and whether the agent may write there; `checklist_read`
// shows the items with their ids; adding and ticking reach the checklist, refused naming it where Write is not given
// (also when it was taken back after the tools were offered) and for an id that is no checklist of the agent's.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Ctx, BACKGROUND_CONTEXT as context, type P3Principal, until } from "@earendil-works/p3/v1";
import { testPlugin } from "@earendil-works/p3/v1/testing";
import type { Extension } from "@earendil-works/p3/v1/worker";
import { within } from "../../../test/until.ts";
import { type HarnessSession, type HeldThing, ThingHarnessParts } from "../../things/contract.worker.ts";
import { Checklist, ChecklistKind } from "../contract.ts";
import { checklistExtension } from "../worker.ts";
import { type Checklists, checklists } from "./checklists.ts";

/** The session's agent. */
const AGENT: P3Principal = { kind: "worker", session: "s1" };

let c: Checklists;
let s1: string;

beforeEach(async () => {
	c = await checklists();
	s1 = await c.workspace("s1");
});

afterEach(() => c.close());

/** The agent's session as the part gets it: its calls run as the session's worker. */
function session(): HarnessSession {
	return { session: "s1", workspace: s1, call: (fn, ctx) => c.t.root(fn, ctx, { principal: AGENT }) };
}

/** Runs `fn` with the agent holding checklists `things` in s1: the part's extension for them, and the held things. */
function giving<T>(
	things: readonly string[],
	fn: (extension: Extension, ctx: Ctx<P3Principal>, held: readonly HeldThing<typeof Checklist>[]) => Promise<T>,
) {
	return c.t.root(
		async (ctx) => {
			const held: HeldThing<typeof Checklist>[] = [];
			for (const thing of things) {
				held.push({ thing, workspace: s1, ref: await ctx.get(Checklist, { workspace: s1, thing }) });
			}
			return fn(checklistExtension(held, session()), ctx, held);
		},
		context,
		{ principal: AGENT },
	);
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

/** The names of `extension`'s tools. */
const names = (extension: Extension) => extension.tools?.map((tool) => tool.name).toSorted();

describe("the checklist kind's harness part", () => {
	it("is contributed by the worker facet", async () => {
		const root = fileURLToPath(new URL("../", import.meta.url));
		const t = await testPlugin(root, { kind: "worker", session: "s1" }, context);
		try {
			// The facet as the plugin tier builds it: its own module, so compared by kind.
			assert.deepEqual(
				t.contributions(ThingHarnessParts).map(({ value }) => value.kind.name),
				[ChecklistKind.name],
			);
		} finally {
			await t.close(context);
		}
	});

	it("offers adding and ticking while one checklist gives Write, and lists which", async () => {
		const [plan, packing] = [await c.checklistIn(s1, "Plan"), await c.checklistIn(s1, "Packing")];
		await c.write(s1, plan, { kind: "agents" }, false);
		await giving([plan, packing], async (extension) => {
			assert.deepEqual(names(extension), ["checklist_add", "checklist_list", "checklist_read", "checklist_tick"]);
			assert.deepEqual(JSON.parse(await run(extension, "checklist_list", {})), [
				{ id: plan, name: "Plan", write: false },
				{ id: packing, name: "Packing", write: true },
			]);
		});
		await giving([plan], async (extension) =>
			assert.deepEqual(names(extension), ["checklist_list", "checklist_read"]),
		);
	});

	it("adds and ticks items, and reads them with their ids", async () => {
		const packing = await c.checklistIn(s1, "Packing");
		await giving([packing], async (extension, ctx, [held]) => {
			const added = await run(extension, "checklist_add", { checklist: packing, text: "tent" });
			const id = /^Added (.+)\.$/.exec(added)?.[1];
			assert.ok(id !== undefined, added);
			await run(extension, "checklist_tick", { checklist: packing, item: id, done: true });
			// The read is the agent's reference's: it shows the tick once it arrived there.
			await until(held!.ref.items, (items) => items[0]?.done === true, within("the tick", ctx));
			assert.deepEqual(JSON.parse(await run(extension, "checklist_read", { checklist: packing })), [
				{ id, text: "tent", done: true },
			]);
		});
	});

	it("refuses to change a checklist without Write, also when taken back after offering, naming it", async () => {
		const [plan, packing] = [await c.checklistIn(s1, "Plan"), await c.checklistIn(s1, "Packing")];
		await c.write(s1, plan, { kind: "agents" }, false);
		await giving([plan, packing], async (extension, ctx, held) => {
			const add = (checklist: string) => run(extension, "checklist_add", { checklist, text: "x" });
			await assert.rejects(add(plan), /may not write in the checklist "Plan"/);
			await c.write(s1, packing, { kind: "agents" }, false);
			const { ref } = held[1]!;
			await until(ref.state, () => ref.add === undefined, within("Write taken back", ctx));
			await assert.rejects(add(packing), /may not write in the checklist "Packing"/);
			await assert.rejects(
				run(extension, "checklist_tick", { checklist: packing, item: "i", done: true }),
				/may not write in the checklist "Packing"/,
			);
		});
	});

	it("refuses an id that is no checklist of the agent's", async () => {
		const plan = await c.checklistIn(s1, "Plan");
		const elsewhere = await c.checklistIn(c.pi, "Elsewhere");
		await giving([plan], async (extension) => {
			for (const checklist of ["c9", elsewhere]) {
				await assert.rejects(run(extension, "checklist_read", { checklist }), /you have no checklist/);
				await assert.rejects(run(extension, "checklist_add", { checklist, text: "x" }), /you have no checklist/);
			}
		});
	});
});
