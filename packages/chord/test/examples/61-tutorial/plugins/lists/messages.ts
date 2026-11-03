// The lists plugin's messages, in English (the source of truth) and German: one file every facet that renders imports,
// and the worker, which writes a notice as data for each viewer to render.

import { defineMessages } from "@todo/app/v1";

export const messages = defineMessages("todo.lists", {
	en: {
		title: "Groceries",
		placeholder: "Add a todo",
		clearDone: "Clear done",
		open: (n: number) => (n === 1 ? "1 open" : `${n} open`),
		cleared: (by: string) => `${by} cleared the done todos`,
	},
	de: {
		title: "Einkäufe",
		placeholder: "Neues Todo",
		clearDone: "Erledigte entfernen",
		open: (n) => `${n} offen`,
		cleared: (by) => `${by} hat die erledigten Todos entfernt`,
	},
});
