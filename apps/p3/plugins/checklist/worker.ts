// The checklist plugin on a session's worker: the checklist kind's harness part, what the checklists the agent holds
// give it. `checklist_list` (each checklist's id, name and whether the agent may write there) and `checklist_read` (a
// checklist's items with their ids) always; `checklist_add` and `checklist_tick` while one of them gives Write,
// refused naming the checklist on the others. The tools take a checklist's id from `checklist_list`, so their
// descriptions stay fixed whatever checklists the agent holds. They reach the checklist through the agent's
// reference, as the session's worker: Write taken back while a call runs refuses that change too.

import {
	bool,
	type Context,
	defineFacet,
	forbidden,
	invalid,
	obj,
	type Reference,
	str,
	type With,
	withGranted,
} from "@earendil-works/p3/v1";
import { defineExtension, defineTool, type Extension } from "@earendil-works/p3/v1/worker";
import { type HarnessSession, type HeldThing, ThingHarnessParts, thingHarnessPart } from "../things/contract.worker.ts";
import { CHECKLIST_WRITES, type Checklist, ChecklistKind, ItemText } from "./contract.ts";

export default defineFacet((_host, self) => {
	self.contribute(
		ThingHarnessParts,
		thingHarnessPart(ChecklistKind, (lists, session) => ({ extension: checklistExtension(lists, session) })),
	);
});

/** A checklist the agent holds. */
type List = HeldThing<typeof Checklist>;

/** The agent's checklist tools (exported for its test): list, read, and add and tick while one gives Write. */
export function checklistExtension(lists: readonly List[], session: HarnessSession): Extension {
	const tools = [listTool(lists), readTool(lists)];
	return defineExtension({
		name: "checklist",
		tools: lists.some(({ ref }) => writer(ref) !== undefined)
			? [...tools, addTool(lists, session), tickTool(lists, session)]
			: tools,
	});
}

/** The tool `checklist_list`: the agent's checklists, with whether it may write in each. */
function listTool(lists: readonly List[]) {
	return defineTool({
		name: "checklist_list",
		description:
			"Lists your checklists as JSON: each one's `id` (what the other checklist tools take), its `name` and whether " +
			"you may `write` in it (add and tick items).",
		parameters: obj({}),
		replay: "safe",
		execute: async () => {
			const shown = lists.map(({ thing, ref }) => ({
				id: thing,
				name: ref.name.value,
				write: writer(ref) !== undefined,
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

/** The tool `checklist_add`: adds an item at the end of a checklist the agent may write in. */
function addTool(lists: readonly List[], session: HarnessSession) {
	return defineTool({
		name: "checklist_add",
		description:
			"Adds an item (`text`) at the end of one of your checklists (`checklist`: its id from `checklist_list`, one " +
			"you may write in); answers the new item's id.",
		parameters: obj({ checklist: str(), text: ItemText }),
		execute: async ({ checklist, text }, _api, context) => {
			const id = await writing(
				listOf(lists, checklist),
				session,
				(writes, ctx) => writes.add({ text }, ctx),
				context,
			);
			return { output: [{ type: "text", text: `Added ${id}.` }] };
		},
	});
}

/** The tool `checklist_tick`: marks an item of a checklist the agent may write in done or not. */
function tickTool(lists: readonly List[], session: HarnessSession) {
	return defineTool({
		name: "checklist_tick",
		description:
			"Ticks (`done: true`) or unticks an item (`item`: its id from checklist_read) of one of your checklists " +
			"(`checklist`: its id from `checklist_list`, one you may write in).",
		parameters: obj({ checklist: str(), item: str(), done: bool() }),
		execute: async ({ checklist, item, done }, _api, context) => {
			await writing(
				listOf(lists, checklist),
				session,
				(writes, ctx) => writes.tick({ id: item, done }, ctx),
				context,
			);
			return { output: [{ type: "text", text: `${done ? "Ticked" : "Unticked"} ${item}.` }] };
		},
	});
}

/** A checklist's members Write gives. */
type Writes = With<Reference<typeof Checklist>, (typeof CHECKLIST_WRITES)[number]>;

/** Runs `change` on `list` as the session's worker, refused unless the agent has Write there at the call. */
function writing<T>(
	list: List,
	session: HarnessSession,
	change: (writes: Writes, ctx: Context) => Promise<T>,
	context: Context,
) {
	return session.call(async (ctx) => {
		// Read at the call: Write may have been taken back since the tools were offered.
		const writes = writer(list.ref);
		if (writes === undefined) throw forbidden(`checklist: you may not write in ${described(list)}`);
		return change(writes, ctx);
	}, context);
}

/** The checklist's members Write gives, while the agent has it there. */
function writer(ref: Reference<typeof Checklist>): Writes | undefined {
	return withGranted(ref, ...CHECKLIST_WRITES);
}

/** The agent's checklist `id`; an id that is none of them is the model's mistake, answered as its error result. */
function listOf(lists: readonly List[], id: string): List {
	const found = lists.find(({ thing }) => thing === id);
	if (found === undefined) {
		throw invalid("args", `checklist: you have no checklist ${JSON.stringify(id)} (see checklist_list)`);
	}
	return found;
}

/** A checklist as an error names it: its name and id. */
function described({ thing, ref }: List): string {
	return `the checklist "${ref.name.value}" (${thing})`;
}
