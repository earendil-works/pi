// The checklist on a session's worker: what the session's checklists give its agent, one set of tools for all of
// them. `checklist_list` (each checklist's id, name and whether the agent may tick there) and `checklist_read` (a
// checklist's items with their ids) always; `checklist_add` and `checklist_tick` only while at least one checklist
// lets the agent tick (the option covers adding too), refused with an error naming the checklist on the others. The tools take a checklist's id from `checklist_list`, so
// their descriptions stay fixed whatever checklists the session has. They reach the checklist on the server
// (`Checklist`) through `agent.call`, as the session's worker, so `admitThing` answers for the agent: options changed
// while a call runs refuse the tick there too.

import { bool, type Context, defineFacet, forbidden, obj, str } from "@earendil-works/p3/v1";
import {
	type Agent,
	type AgentThing,
	defineExtension,
	defineTool,
	type Extension,
	ThingExtensions,
	thingExtension,
} from "@earendil-works/p3/v1/worker";
import { Checklist, ChecklistKind, ItemText } from "./contract.ts";

export default defineFacet((_host, self) => {
	self.contribute(
		ThingExtensions,
		// Called with every checklist of the session, again whenever they change.
		thingExtension(ChecklistKind, (lists, agent) => ({ extension: checklistExtension(lists, agent) })),
	);
});

/** A checklist of the session as the tools get it. */
type List = AgentThing<{ check: boolean }>;

/** The tools of the session's checklists: listing and reading, and ticking while one of them allows it. */
function checklistExtension(lists: readonly List[], agent: Agent): Extension {
	const list = defineTool({
		name: "checklist_list",
		description:
			"Lists the session's checklists as JSON: each one's `id` (what the other checklist tools take), its `name` " +
			"and whether you may `tick` its items.",
		parameters: obj({}),
		execute: async () => {
			const shown = lists.map(({ thing, name, options }) => ({ id: thing, name, tick: options.check }));
			return { output: [{ type: "text", text: JSON.stringify(shown) }] };
		},
	});
	const read = defineTool({
		name: "checklist_read",
		description:
			"Reads one of the session's checklists (`checklist`: its id from `checklist_list`): its items as JSON, each " +
			"with its `id` (what checklist_tick takes), `text` and whether it is `done`.",
		parameters: obj({ checklist: str() }),
		execute: async ({ checklist }, _api, context) => {
			const at = { session: agent.session, thing: listOf(lists, checklist).thing };
			const items = await agent.call(async (ctx) => (await ctx.get(Checklist, at)).items.value, context);
			return { output: [{ type: "text", text: JSON.stringify(items) }] };
		},
	});
	const add = defineTool({
		name: "checklist_add",
		description:
			"Adds an item (`text`) at the end of one of the session's checklists (`checklist`: its id from " +
			"`checklist_list`, one you may tick); answers the new item's id.",
		parameters: obj({ checklist: str(), text: ItemText }),
		execute: async ({ checklist, text }, _api, context) => {
			const id = await change(lists, checklist, { kind: "add", text }, agent, context);
			return { output: [{ type: "text", text: `Added ${id}.` }] };
		},
	});
	const tick = defineTool({
		name: "checklist_tick",
		description:
			"Ticks (`done: true`) or unticks an item (`item`: its id from checklist_read) of one of the session's " +
			"checklists (`checklist`: its id from `checklist_list`, one you may tick).",
		parameters: obj({ checklist: str(), item: str(), done: bool() }),
		execute: async ({ checklist, item, done }, _api, context) => {
			await change(lists, checklist, { kind: "tick", item, done }, agent, context);
			return { output: [{ type: "text", text: `${done ? "Ticked" : "Unticked"} ${item}.` }] };
		},
	});
	return defineExtension({
		name: "checklist",
		tools: lists.some(({ options }) => options.check) ? [list, read, add, tick] : [list, read],
	});
}

/** A change the agent makes to a checklist. */
type Change = { kind: "add"; text: string } | { kind: "tick"; item: string; done: boolean };

/**
 * Makes `change` on checklist `id` as the agent, through the object people use: refused when the agent may not tick
 * there (its options now, which also cover adding). Answers the new item's id for an add.
 */
async function change(
	lists: readonly List[],
	id: string,
	change: Change,
	agent: Agent,
	context: Context,
): Promise<string | null> {
	const found = listOf(lists, id);
	if (!found.options.check) throw forbidden(`checklist: you may not change ${described(found)}`);
	return agent.call(async (ctx) => {
		const at = await ctx.get(Checklist, { session: agent.session, thing: found.thing });
		if (at.add === undefined || at.tick === undefined)
			throw forbidden(`checklist: you may not change ${described(found)} now`);
		switch (change.kind) {
			case "add":
				return at.add({ text: change.text }, ctx);
			case "tick":
				return at.tick({ id: change.item, done: change.done }, ctx);
		}
	}, context);
}

/** The session's checklist `id`; an id that is none of them is the model's mistake, answered as its error result. */
function listOf(lists: readonly List[], id: string): List {
	const found = lists.find(({ thing }) => thing === id);
	if (found === undefined) {
		throw new Error(`checklist: the session has no checklist ${JSON.stringify(id)} (see checklist_list)`);
	}
	return found;
}

/** A checklist as an error names it: its name and id. */
function described({ thing, name }: List): string {
	return name === "" ? `the checklist ${thing}` : `the checklist "${name}" (${thing})`;
}
