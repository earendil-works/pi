// The notes plugin's texts people see: its tick's label (decision 65), as the things plugin's Settings view shows it,
// and the notebook view's texts. Imported by the contract and by every facet that renders.

import { defineMessages } from "@earendil-works/p3/v1";

/** The notes plugin's messages, by key. */
export const messages = defineMessages("notes", {
	en: {
		tickWrite: "Write",
		untitled: "Notes",
		readOnly: "Read only",
		denied: "You may not read these notes.",
		unavailable: "These notes cannot be shown now.",
		loading: "Loading…",
		empty: "No notes yet.",
		older: "Older notes",
		newNote: "New note",
		newNotePlaceholder: "A new note",
		add: "Add",
		note: "Note",
		edit: "Edit",
		remove: "Delete",
		save: "Save",
		cancel: "Cancel",
		byAgent: "An agent",
		byPi: "Pi",
		written: (author: string, at: string) => `${author} · ${at}`,
	},
});
