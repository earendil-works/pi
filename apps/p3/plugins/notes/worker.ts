// The notes plugin on a session's worker: what the session's notebooks give its agent. `notes_list` (the session's
// notebooks: id, name, whether the agent may write there) and `notes_read({ notebook })` always; `notes_write({
// notebook, text })` when the agent may edit at least one notebook, refused with an error naming the notebook on the
// others. The tools take a notebook's id from `notes_list`, so their descriptions stay fixed whatever notebooks the
// session has. They reach the notebook on the server (`Notes`) through `agent.call`, as the session's worker, so
// `admitThing` answers for the agent (its access and its options): options changed while a call runs refuse the
// write there too.

import { defineFacet, forbidden, int, obj, opt, str } from "@earendil-works/p3/v1";
import {
	type Agent,
	type AgentThing,
	defineExtension,
	defineTool,
	type Extension,
	ThingExtensions,
	thingExtension,
} from "@earendil-works/p3/v1/worker";
import { type Note, Notes, NotesKind, NoteText } from "./contract.ts";

export default defineFacet((_host, self) => {
	self.contribute(
		ThingExtensions,
		thingExtension(NotesKind, (things, agent) => ({ extension: notesExtension(things, agent) })),
	);
});

/** A notebook of the session as the notes tools get it. */
type Notebook = AgentThing<{ edit: boolean }>;

/** The tools of the session's notebooks: listing and reading, and writing when the agent may edit one of them. */
function notesExtension(things: readonly Notebook[], agent: Agent): Extension {
	const list = defineTool({
		name: "notes_list",
		description:
			"Lists the session's notebooks as JSON: each one's `id` (what the other notes tools take), its `name` and " +
			"whether you may `write` in it.",
		parameters: obj({}),
		execute: async () => {
			const notebooks = things.map(({ thing, name, options }) => ({ id: thing, name, write: options.edit }));
			return { output: [{ type: "text", text: JSON.stringify(notebooks) }] };
		},
	});
	const read = defineTool({
		name: "notes_read",
		description:
			"Reads the notes of one of the session's notebooks (`notebook`: its id from `notes_list`), the last written " +
			"first, a page of 50 notes at a time.",
		parameters: obj({ notebook: str(), pages: opt(int({ min: 1, max: 10 })) }),
		execute: async ({ notebook: id, pages }, _api, context) => {
			const at = { session: agent.session, thing: notebookOf(things, id).thing };
			const notes = await agent.call(async (ctx) => {
				const notebook = await ctx.get(Notes, at);
				for (let page = 1; page < (pages ?? 1) && notebook.list.value.moreAfter; page++) await notebook.more(ctx);
				return notebook.list.value;
			}, context);
			return { output: [{ type: "text", text: listed(notes.rows, notes.moreAfter) }] };
		},
	});
	const write = defineTool({
		name: "notes_write",
		description:
			"Adds a note to one of the session's notebooks (`notebook`: its id from `notes_list`, one you may write in).",
		parameters: obj({ notebook: str(), text: NoteText }),
		execute: async ({ notebook: id, text }, _api, context) => {
			const thing = notebookOf(things, id);
			if (!thing.options.edit) throw forbidden(`notes: you may not write in ${described(thing)}`);
			const added = await agent.call(async (ctx) => {
				const notebook = await ctx.get(Notes, { session: agent.session, thing: thing.thing });
				if (notebook.add === undefined) throw forbidden(`notes: you may not write in ${described(thing)} now`);
				return notebook.add({ text }, ctx);
			}, context);
			return { output: [{ type: "text", text: `Added note ${added}.` }] };
		},
	});
	return defineExtension({
		name: "notes",
		tools: things.some(({ options }) => options.edit) ? [list, read, write] : [list, read],
	});
}

/** The session's notebook `id`; an id that is none of them is the model's mistake, answered as its error result. */
function notebookOf(things: readonly Notebook[], id: string): Notebook {
	const found = things.find(({ thing }) => thing === id);
	if (found === undefined)
		throw new Error(`notes: the session has no notebook ${JSON.stringify(id)} (see notes_list)`);
	return found;
}

/** A notebook as an error names it: its name and id. */
function described({ thing, name }: Notebook): string {
	return name === "" ? `the notebook ${thing}` : `the notebook "${name}" (${thing})`;
}

/** Notes as the agent reads them: one per line with its time and author, and whether older ones were left out. */
function listed(rows: readonly Note[], more: boolean): string {
	if (rows.length === 0) return "The notebook is empty.";
	const lines = rows.map((note) => `- ${new Date(note.at).toISOString()} ${writer(note)}: ${note.text}`);
	return [...lines, ...(more ? ["(older notes follow: read more pages)"] : [])].join("\n");
}

/** Who wrote a note, for the agent. */
function writer(note: Note): string {
	switch (note.author.kind) {
		case "person":
			return note.author.name;
		case "agent":
			return "an agent";
	}
}
