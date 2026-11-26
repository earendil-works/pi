// The notes plugin's texts people see: its tick's label (decision 65), as the things plugin's Settings view shows it,
// the notebook view's texts and the refusals a person can cause. Imported by the kind, the store and every facet that
// renders.

import { defineMessages, formatTime } from "@earendil-works/p3/v1";

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
		more: "More notes",
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
		noNote: "This note is not here any more.",
		gone: "This notebook does not exist any more.",
		written: (author: string, at: number) =>
			`${author} · ${formatTime(at, { dateStyle: "medium", timeStyle: "short" })}`,
	},
});
