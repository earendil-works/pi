// The notes plugin on a session's worker: what a notebook gives the session's agent. `notes_read` always, and
// `notes_write` only when the agent's options say `edit`; both reach the notebook on the server (`Notes`) through
// `agent.call`, as the session's worker, so `admitThing` answers for the agent (its access and its options): options
// changed while a call runs refuse the write there too.

import { defineFacet, forbidden, int, obj, opt } from "@earendil-works/p3/v1";
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
		thingExtension(NotesKind, (thing, agent) => ({ extension: notesExtension(thing, agent) })),
	);
});

/** The tools of one notebook: reading, and writing when the agent's options say `edit`. */
function notesExtension(thing: AgentThing<{ edit: boolean }>, agent: Agent): Extension {
	const at = { session: agent.session, thing: thing.thing };
	const read = defineTool({
		name: "notes_read",
		description: "Reads the notes of the session's notebook, the last written first, a page of 50 notes at a time.",
		parameters: obj({ pages: opt(int({ min: 1, max: 10 })) }),
		execute: async ({ pages }, _api, context) => {
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
		description: "Adds a note to the session's notebook.",
		parameters: obj({ text: NoteText }),
		execute: async ({ text }, _api, context) => {
			const id = await agent.call(async (ctx) => {
				const notebook = await ctx.get(Notes, at);
				if (notebook.variant !== "editor") throw forbidden("notes: the agent may not edit this notebook now");
				return notebook.add({ text }, ctx);
			}, context);
			return { output: [{ type: "text", text: `Added note ${id}.` }] };
		},
	});
	return defineExtension({ name: "notes", tools: thing.options.edit ? [read, write] : [read] });
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
		case "owner":
			return "the owner";
		case "person":
			return note.author.name;
		case "agent":
			return "an agent";
	}
}
