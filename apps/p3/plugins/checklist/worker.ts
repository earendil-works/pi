// The checklist plugin on a session's worker: the checklist kind's harness part, what the checklists the agent holds
// give it. `checklist_list` (each checklist's id, name and whether the agent may add and tick there) and
// `checklist_read` (a checklist's items with their ids) always; `checklist_add` while one of them gives Add and
// `checklist_tick` while one gives Tick, each refused naming the checklist on the others. The tools take a
// checklist's id from `checklist_list`, so their descriptions stay fixed whatever checklists the agent holds. They
// call the agent's held reference (decision 120): a tick taken back after the tools were offered refuses the change
// at the call. Reads and changes answer JSON.

import { bool, defineFacet, forbidden, invalid, obj, str } from "@earendil-works/p3/v1";
import { defineTool } from "@earendil-works/p3/v1/worker";
import {
	type HarnessExtension,
	type HeldThing,
	ThingHarnessParts,
	thingHarnessPart,
} from "../things/contract.worker.ts";
import { type Checklist, ChecklistKind, ItemText } from "./kind.ts";

export default defineFacet((_host, self) => {
	self.contribute(
		ThingHarnessParts,
		thingHarnessPart(ChecklistKind, (lists) => ({ extension: checklistExtension(lists) })),
	);
});

/** A checklist the agent holds. */
type List = HeldThing<typeof Checklist>;

/** The agent's checklist tools: list and read, add while one checklist gives Add, tick while one gives Tick. */
function checklistExtension(lists: readonly List[]): HarnessExtension {
	const tools = [listTool(lists), readTool(lists)];
	if (lists.some(({ ref }) => ref.addItem !== undefined)) tools.push(addTool(lists));
	if (lists.some(({ ref }) => ref.setDone !== undefined)) tools.push(tickTool(lists));
	// Installed under the kind's name by the harness.
	return { tools };
}

/** The tool `checklist_list`: the agent's checklists, with whether it may add and tick in each. */
function listTool(lists: readonly List[]) {
	return defineTool({
		name: "checklist_list",
		description:
			"Lists your checklists as JSON: each one's `id` (what the other checklist tools take), its `name` (empty when " +
			"it has none) and whether you may `add` items and `tick` them there.",
		parameters: obj({}),
		replay: "safe",
		execute: async () => {
			const shown = lists.map(({ thing, ref }) => ({
				id: thing,
				name: ref.name.value,
				add: ref.addItem !== undefined,
				tick: ref.setDone !== undefined,
			}));
			return { output: [{ type: "text", text: JSON.stringify(shown) }] };
		},
	});
}

/** The tool `checklist_read`: a checklist's items, in the order they were added. */
function readTool(lists: readonly List[]) {
	return defineTool({
		name: "checklist_read",
		description:
			"Reads one of your checklists (`checklist`: its id from `checklist_list`): its items as JSON, each with its " +
			"`id` (what checklist_tick takes), `text` and whether it is `done`.",
		parameters: obj({ checklist: str() }),
		replay: "safe",
		// The agent's reference holds the items whole (a checklist has at most 500).
		execute: async ({ checklist }) => ({
			output: [{ type: "text", text: JSON.stringify(listOf(lists, checklist).ref.items.value) }],
		}),
	});
}

/** The tool `checklist_add`: adds an item at the end of a checklist the agent may add to. */
function addTool(lists: readonly List[]) {
	return defineTool({
		name: "checklist_add",
		description:
			"Adds an item (`text`) at the end of one of your checklists (`checklist`: its id from `checklist_list`, one " +
			"you may add to); answers JSON: the new item's `{ id }`.",
		parameters: obj({ checklist: str(), text: ItemText }),
		execute: async ({ checklist, text }, _api, context) => {
			const list = listOf(lists, checklist);
			// Read at the call: Add may have been taken back since the tools were offered.
			const { addItem } = list.ref;
			if (addItem === undefined) throw refusal("add to", list);
			const id = await addItem({ text }, context);
			return { output: [{ type: "text", text: JSON.stringify({ id }) }] };
		},
	});
}

/** The tool `checklist_tick`: marks an item of a checklist the agent may tick done or not. */
function tickTool(lists: readonly List[]) {
	return defineTool({
		name: "checklist_tick",
		description:
			"Ticks (`done: true`) or unticks an item (`item`: its id from checklist_read) of one of your checklists " +
			"(`checklist`: its id from `checklist_list`, one you may tick); answers JSON `{}`.",
		parameters: obj({ checklist: str(), item: str(), done: bool() }),
		execute: async ({ checklist, item, done }, _api, context) => {
			const list = listOf(lists, checklist);
			// Read at the call: Tick may have been taken back since the tools were offered.
			const { setDone } = list.ref;
			if (setDone === undefined) throw refusal("tick", list);
			await setDone({ id: item, done }, context);
			return { output: [{ type: "text", text: "{}" }] };
		},
	});
}

/** The refusal of a change the agent may not make in `list`. */
function refusal(change: string, { thing, ref }: List) {
	return forbidden(`checklist: you may not ${change} the checklist "${ref.name.value}" (${thing})`);
}

/** The agent's checklist `id`; an id that is none of them is the model's mistake, answered as its error result. */
function listOf(lists: readonly List[], id: string): List {
	const found = lists.find(({ thing }) => thing === id);
	if (found === undefined) {
		throw invalid("args", `checklist: you have no checklist ${JSON.stringify(id)} (see checklist_list)`);
	}
	return found;
}
