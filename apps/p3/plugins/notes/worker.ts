// The notes plugin on a session's worker: the notes kind's harness part, what the notebooks the agent holds give it.
// `notes_list` (each notebook's id, name and whether the agent may write there) and `notes_read({ notebook, after })`
// (a page of notes as JSON) always; `notes_write({ notebook, change })` (add, edit or remove a note) while one of them
// gives Write, refused naming the notebook on the others. The tools take a notebook's id from `notes_list`, so their
// descriptions stay fixed whatever notebooks the agent holds. They reach the notebook through the agent's reference,
// as the session's worker: Write taken back after the tools were offered refuses the write at the call.

import {
	defineFacet,
	forbidden,
	invalid,
	lit,
	obj,
	opt,
	type Reference,
	str,
	union,
	withGranted,
} from "@earendil-works/p3/v1";
import { defineExtension, defineTool, type Extension } from "@earendil-works/p3/v1/worker";
import { type HarnessSession, type HeldThing, ThingHarnessParts, thingHarnessPart } from "../things/contract.worker.ts";
import { NOTES_WRITES, type Notes, NotesKind, NoteText } from "./contract.ts";

export default defineFacet((_host, self) => {
	self.contribute(
		ThingHarnessParts,
		thingHarnessPart(NotesKind, (things, session) => ({ extension: notesExtension(things, session) })),
	);
});

/** A notebook the agent holds. */
type Notebook = HeldThing<typeof Notes>;

/** The agent's notes tools: list and read, and write while one notebook gives Write. */
function notesExtension(things: readonly Notebook[], session: HarnessSession): Extension {
	const tools = [listTool(things), readTool(things, session)];
	return defineExtension({
		name: "notes",
		tools: things.some(({ ref }) => writer(ref) !== undefined) ? [...tools, writeTool(things, session)] : tools,
	});
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

/** The tool `notes_read`: a page of a notebook's notes, the last written first, as JSON. */
function readTool(things: readonly Notebook[], session: HarnessSession) {
	return defineTool({
		name: "notes_read",
		description:
			"Reads a page of the notes of one of your notebooks (`notebook`: its id from `notes_list`), the last written " +
			"first, as JSON: `rows` (each note's `id`, `text`, `at` in ms since the epoch and `author`) and `next`, which " +
			"`after` takes for the next page (absent: no older notes).",
		parameters: obj({ notebook: str(), after: opt(str()) }),
		replay: "safe",
		execute: async ({ notebook, after }, _api, context) => {
			const { ref } = notebookOf(things, notebook);
			// A page read now: the agent's reference keeps the pages it holds, whatever the agent reads.
			const page = await session.call((ctx) => ref.page(after === undefined ? {} : { after }, ctx), context);
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
function writeTool(things: readonly Notebook[], session: HarnessSession) {
	return defineTool({
		name: "notes_write",
		description:
			"Changes one of your notebooks (`notebook`: its id from `notes_list`, one you may write in), which everyone " +
			'there sees at once: `change` is `{ kind: "add", text }`, `{ kind: "edit", id, text }` (a note\'s id from ' +
			'`notes_read`) or `{ kind: "remove", id }`.',
		parameters: obj({ notebook: str(), change: Change }),
		execute: async ({ notebook, change }, _api, context) => {
			const { thing, ref } = notebookOf(things, notebook);
			const text = await session.call(async (ctx) => {
				// Read at the call: Write may have been taken back since the tools were offered.
				const writes = writer(ref);
				if (writes === undefined)
					throw forbidden(`notes: you may not write in the notebook "${ref.name.value}" (${thing})`);
				switch (change.kind) {
					case "add":
						return `Added note ${await writes.add({ text: change.text }, ctx)}.`;
					case "edit":
						await writes.edit({ id: change.id, text: change.text }, ctx);
						return `Edited note ${change.id}.`;
					case "remove":
						await writes.remove({ id: change.id }, ctx);
						return `Removed note ${change.id}.`;
				}
			}, context);
			return { output: [{ type: "text", text }] };
		},
	});
}

/** The notebook's members Write gives, while the agent has it there. */
function writer(ref: Reference<typeof Notes>) {
	return withGranted(ref, ...NOTES_WRITES);
}

/** The agent's notebook `id`; an id that is none of them is the model's mistake, answered as its error result. */
function notebookOf(things: readonly Notebook[], id: string): Notebook {
	const found = things.find(({ thing }) => thing === id);
	if (found === undefined) throw invalid("args", `notes: you have no notebook ${JSON.stringify(id)} (see notes_list)`);
	return found;
}
