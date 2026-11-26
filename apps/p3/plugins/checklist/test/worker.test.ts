// The checklist kind's harness part, as the worker facet contributes it to `ThingHarnessParts`, given the checklists
// an agent holds (real references, held as the session's worker on a server with the things plugin, `kindServer`): it
// offers `checklist_list` and `checklist_read` always, `checklist_add` while one checklist gives Add and
// `checklist_tick` while one gives Tick; `checklist_list` names each checklist with its id and what the agent may do
// there; `checklist_read` shows the items with their ids; adding and ticking reach the checklist, each refused naming
// it where its tick is not given (also when taken back after the tools were offered) and for an id that is no
// checklist of the agent's.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Ctx, BACKGROUND_CONTEXT as context, type P3Principal, until } from "@earendil-works/p3/v1";
import type { Extension } from "@earendil-works/p3/v1/worker";
import { within } from "../../../test/until.ts";
import { type HeldThing, ThingHarnessParts } from "../../things/contract.worker.ts";
import { type KindServer, kindServer, runTool, toolNames } from "../../things/test/kind-server.ts";
import { type Checklist, ChecklistKind } from "../contract.ts";
import checklistServer from "../server.ts";

/** The checklist plugin's root. */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session's agent as a party: a tick withheld from it by name applies by every route (item 106). */
const AGENT_PARTY = { kind: "agent", session: "s1" } as const;

let c: KindServer<typeof Checklist>;
let s1: string;

beforeEach(async () => {
	c = await kindServer(
		{ name: "@earendil-works/p3-checklist", root: ROOT, server: checklistServer },
		ChecklistKind,
		context,
	);
	s1 = await c.workspace("s1");
});

afterEach(() => c.close());

/** Runs `fn` with s1's agent holding checklists `things` there: the part's extension for them, and the held things. */
const giving = <T>(
	things: readonly string[],
	fn: (extension: Extension, ctx: Ctx<P3Principal>, held: readonly HeldThing<typeof Checklist>[]) => Promise<T>,
) => c.giving({ session: "s1", workspace: s1 }, things, fn);

describe("the checklist kind's harness part", () => {
	it("is the worker facet's one part, for the checklist kind", async () => {
		assert.deepEqual(
			(await c.part()).contributions(ThingHarnessParts).map(({ value }) => value.kind.name),
			[ChecklistKind.name],
		);
	});

	it("offers adding and ticking each while one checklist gives it, and lists which", async () => {
		const [plan, packing] = [await c.thingIn(s1, "Plan"), await c.thingIn(s1, "Packing")];
		await c.tick(s1, packing, AGENT_PARTY, "add", true);
		await giving([plan, packing], async (extension) => {
			assert.deepEqual(toolNames(extension), [
				"checklist_add",
				"checklist_list",
				"checklist_read",
				"checklist_tick",
			]);
			assert.deepEqual(JSON.parse(await runTool(extension, "checklist_list", {}, context)), [
				{ id: plan, name: "Plan", add: false, tick: true },
				{ id: packing, name: "Packing", add: true, tick: true },
			]);
		});
		// By default the agent ticks and adds nothing (Astra: it was given Add).
		await giving([plan], async (extension) =>
			assert.deepEqual(toolNames(extension), ["checklist_list", "checklist_read", "checklist_tick"]),
		);
		await c.tick(s1, plan, AGENT_PARTY, "tick", false);
		await giving([plan], async (extension) =>
			assert.deepEqual(toolNames(extension), ["checklist_list", "checklist_read"]),
		);
	});

	it("adds and ticks items, and reads them with their ids", async () => {
		const packing = await c.thingIn(s1, "Packing");
		await c.tick(s1, packing, AGENT_PARTY, "add", true);
		await giving([packing], async (extension, ctx, [held]) => {
			const added = await runTool(extension, "checklist_add", { checklist: packing, text: "tent" }, context);
			const id = /^Added (.+)\.$/.exec(added)?.[1];
			assert.ok(id !== undefined, added);
			await runTool(extension, "checklist_tick", { checklist: packing, item: id, done: true }, context);
			// The read is the agent's reference's: it shows the tick once it arrived there.
			await until(held!.ref.items, (items) => items[0]?.done === true, within("the tick", ctx));
			assert.deepEqual(JSON.parse(await runTool(extension, "checklist_read", { checklist: packing }, context)), [
				{ id, text: "tent", done: true },
			]);
		});
	});

	it("refuses a change without its tick, also when taken back after offering, naming the checklist", async () => {
		const [plan, packing] = [await c.thingIn(s1, "Plan"), await c.thingIn(s1, "Packing")];
		await c.tick(s1, packing, AGENT_PARTY, "add", true);
		await giving([plan, packing], async (extension, ctx, held) => {
			await assert.rejects(
				runTool(extension, "checklist_add", { checklist: plan, text: "x" }, context),
				/may not add to the checklist "Plan"/,
			);
			await c.tick(s1, packing, AGENT_PARTY, "tick", false);
			const { ref } = held[1]!;
			await until(ref.state, () => ref.setDone === undefined, within("Tick taken back", ctx));
			await assert.rejects(
				runTool(extension, "checklist_tick", { checklist: packing, item: "i", done: true }, context),
				/may not tick the checklist "Packing"/,
			);
		});
	});

	it("refuses an id that is no checklist of the agent's", async () => {
		const plan = await c.thingIn(s1, "Plan");
		const elsewhere = await c.thingIn(c.pi, "Elsewhere");
		await giving([plan], async (extension) => {
			for (const checklist of ["c9", elsewhere]) {
				await assert.rejects(runTool(extension, "checklist_read", { checklist }, context), /you have no checklist/);
				await assert.rejects(
					runTool(extension, "checklist_tick", { checklist, item: "i", done: true }, context),
					/you have no checklist/,
				);
			}
		});
	});
});
