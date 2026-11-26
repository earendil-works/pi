// The notes plugin on a session's worker: the notes kind's harness part, what the notebooks the agent holds give it.
// `notes_list` (each notebook's id, name and whether the agent may write there) and `notes_read({ notebook, after })`
// (a page of notes as JSON) always; `notes_write({ notebook, change })` (add, edit or remove a note) while one of them
// gives Write, refused naming the notebook on the others. The tools take a notebook's id from `notes_list`, so their
// descriptions stay fixed whatever notebooks the agent holds. They call the agent's held reference (decision 120):
// Write taken back after the tools were offered refuses the write at the call. Reads and changes answer JSON.

import {
	type Context,
	defineFacet,
	forbidden,
	invalid,
	lit,
	obj,
	opt,
	type Reference,
	type Static,
	str,
	union,
	type With,
	withGranted,
} from "@earendil-works/p3/v1";
import { defineTool } from "@earendil-works/p3/v1/worker";
import {
	type HarnessExtension,
	type HeldThing,
	ThingHarnessParts,
	thingHarnessPart,
} from "../things/contract.worker.ts";
import { NOTES_WRITES, type Notes, NotesKind, NoteText } from "./kind.ts";

export default defineFacet((_host, self) => {
	self.contribute(
		ThingHarnessParts,
		thingHarnessPart(NotesKind, (things) => ({ extension: notesExtension(things) })),
	);
});

/** A notebook the agent holds. */
type Notebook = HeldThing<typeof Notes>;

/** The agent's notes tools: list and read, and write while one notebook gives Write. */
function notesExtension(things: readonly Notebook[]): HarnessExtension {
	const tools = [listTool(things), readTool(things)];
	// Installed under the kind's name by the harness.
	return { tools: things.some(({ ref }) => writer(ref) !== undefined) ? [...tools, writeTool(things)] : tools };
}

/** The tool `notes_list`: the agent's notebooks, with whether it may write in each. */
function listTool(things: readonly Notebook[]) {
	return defineTool({
		name: "notes_list",
		description:
			"Lists your notebooks as JSON: each one's `id` (what the other notes tools take), its `name` (empty when it " +
			"has none) and whether you may `write` in it.",
		parameters: obj({}),
		replay: "safe",
		execute: async () => {
			const notebooks = things.map(({ thing, ref }) => ({
				id: thing,
				name: ref.name.value,
				write: writer(ref) !== undefined,
			}));
			return { output: [{ type: "text", text: JSON.stringify(notebooks) }] };
		},
	});
}

/** The tool `notes_read`: a page of a notebook's notes, in the notebook's order, as JSON. */
function readTool(things: readonly Notebook[]) {
	return defineTool({
		name: "notes_read",
		description:
			"Reads a page of the notes of one of your notebooks (`notebook`: its id from `notes_list`) in the notebook's " +
			"order, as JSON: `order` (`newest`: the last written first; `oldest`: the least recently written first), " +
			"`rows` (each note's `id`, `text`, `at` in ms since the epoch and `author`) and `next`, which `after` takes " +
			"for the next page (absent: no more notes). If the order changed since, read again from the start.",
		parameters: obj({ notebook: str(), after: opt(str()) }),
		replay: "safe",
		execute: async ({ notebook, after }, _api, context) => {
			const { ref } = notebookOf(things, notebook);
			// A page read now: the agent's reference keeps the pages it holds, whatever the agent reads.
			const page = await ref.page(after === undefined ? {} : { after }, context);
			return { output: [{ type: "text", text: JSON.stringify(page) }] };
		},
	});
}

/** What `notes_write` does: adds a note, replaces one's text, or removes one. */
const Change = union([
	obj({ kind: lit("add"), text: NoteText }),
	obj({ kind: lit("edit"), id: str(), text: NoteText }),
	obj({ kind: lit("remove"), id: str() }),
]);

/** The tool `notes_write`: adds, edits or removes a note of a notebook the agent may write in. */
function writeTool(things: readonly Notebook[]) {
	return defineTool({
		name: "notes_write",
		description:
			"Changes one of your notebooks (`notebook`: its id from `notes_list`, one you may write in), which everyone " +
			'there sees at once: `change` is `{ kind: "add", text }`, `{ kind: "edit", id, text }` (a note\'s id from ' +
			'`notes_read`) or `{ kind: "remove", id }`; answers JSON: the new note\'s `{ id }`, else `{}`.',
		parameters: obj({ notebook: str(), change: Change }),
		execute: async ({ notebook, change }, _api, context) => {
			const { thing, ref } = notebookOf(things, notebook);
			// Read at the call: Write may have been taken back since the tools were offered.
			const writes = writer(ref);
			if (writes === undefined) {
				throw forbidden(`notes: you may not write in the notebook "${ref.name.value}" (${thing})`);
			}
			const answer = await written(writes, change, context);
			return { output: [{ type: "text", text: JSON.stringify(answer) }] };
		},
	});
}

/** Makes `change` through `writes`: the new note's `{ id }`, else `{}`. */
async function written(writes: Writes, change: Static<typeof Change>, context: Context): Promise<{ id?: string }> {
	switch (change.kind) {
		case "add":
			return { id: await writes.add({ text: change.text }, context) };
		case "edit":
			await writes.edit({ id: change.id, text: change.text }, context);
			return {};
		case "remove":
			await writes.remove({ id: change.id }, context);
			return {};
	}
}

/** A notebook's members Write gives. */
type Writes = With<Reference<typeof Notes>, (typeof NOTES_WRITES)[number]>;

/** The notebook's members Write gives, while the agent has it there. */
function writer(ref: Reference<typeof Notes>): Writes | undefined {
	return withGranted(ref, ...NOTES_WRITES);
}

/** The agent's notebook `id`; an id that is none of them is the model's mistake, answered as its error result. */
function notebookOf(things: readonly Notebook[], id: string): Notebook {
	const found = things.find(({ thing }) => thing === id);
	if (found === undefined) throw invalid("args", `notes: you have no notebook ${JSON.stringify(id)} (see notes_list)`);
	return found;
}
