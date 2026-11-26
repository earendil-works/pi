// The notes plugin on a session's worker: the notes kind's harness part, what the notebooks the agent holds give it.
// `notes_list` (each notebook's id, name and whether the agent may write there) and `notes_read({ notebook })` always;
// `notes_write({ notebook, change })` (add, edit or remove a note) while one of them gives Write, refused naming the
// notebook on the others. The tools take a notebook's id from `notes_list`, so their descriptions stay fixed whatever
// notebooks the agent holds. They reach the notebook through the agent's reference, as the session's worker: Write
// taken back while a call runs refuses that write too.

import {
	defineFacet,
	forbidden,
	int,
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
import { NOTES_WRITES, type Note, Notes, NotesKind, NoteText } from "./contract.ts";

export default defineFacet((_host, self) => {
	self.contribute(
		ThingHarnessParts,
		thingHarnessPart(NotesKind, (things, session) => ({ extension: notesExtension(things, session) })),
	);
});

/** A notebook the agent holds. */
type Notebook = HeldThing<typeof Notes>;

/** The agent's notes tools (exported for its test): list and read, and write while one notebook gives Write. */
export function notesExtension(things: readonly Notebook[], session: HarnessSession): Extension {
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
			"Lists your notebooks as JSON: each one's `id` (what the other notes tools take), its `name` and whether you " +
			"may `write` in it.",
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

/** The tool `notes_read`: a notebook's notes, the last written first, a page of 50 at a time. */
function readTool(things: readonly Notebook[], session: HarnessSession) {
	return defineTool({
		name: "notes_read",
		description:
			"Reads the notes of one of your notebooks (`notebook`: its id from `notes_list`), the last written first, each " +
			"with its id, when and by whom it was written; `pages` pages of 50 notes (1 by default).",
		parameters: obj({ notebook: str(), pages: opt(int({ min: 1, max: 20 })) }),
		replay: "safe",
		execute: async ({ notebook: id, pages }, _api, context) => {
			const { thing, workspace } = notebookOf(things, id);
			// A reference of its own: reading older pages grows this call's list, not the one the agent holds.
			const list = await session.call(async (ctx) => {
				const notebook = await ctx.get(Notes, { workspace, thing });
				for (let page = 1; page < (pages ?? 1) && notebook.list.value.moreAfter; page++) await notebook.more(ctx);
				return notebook.list.value;
			}, context);
			return { output: [{ type: "text", text: listed(list.rows, list.moreAfter) }] };
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
		execute: async ({ notebook: id, change }, _api, context) => {
			const notebook = notebookOf(things, id);
			const text = await session.call(async (ctx) => {
				// Read at the call: Write may have been taken back since the tools were offered.
				const writes = writer(notebook.ref);
				if (writes === undefined) throw forbidden(`notes: you may not write in ${described(notebook)}`);
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

/** A notebook as an error names it: its name and id. */
function described({ thing, ref }: Notebook): string {
	return `the notebook "${ref.name.value}" (${thing})`;
}

/** Notes as the agent reads them: one per line with its id, time and author, and whether older ones were left out. */
function listed(rows: readonly Note[], more: boolean): string {
	if (rows.length === 0) return "The notebook is empty.";
	const lines = rows.map(
		(note) => `- [${note.id}] ${new Date(note.at).toISOString()} ${authorName(note)}: ${note.text}`,
	);
	return [...lines, ...(more ? ["(older notes follow: read more pages)"] : [])].join("\n");
}

/** Who wrote a note, for the agent. */
function authorName({ author }: Note): string {
	switch (author.kind) {
		case "person":
			return author.name;
		case "agent":
			return `the agent of session ${author.session}`;
		case "server":
			return "Pi";
	}
}
