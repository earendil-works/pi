// The checklist plugin's texts people see: its ticks' labels (decision 65), as the things plugin's Settings view shows
// them, and the checklist view's texts. Imported by the contract and by every facet that renders.

import { defineMessages } from "@earendil-works/p3/v1";

/** The checklist plugin's messages, by key. */
export const messages = defineMessages("checklist", {
	en: {
		tickAdd: "Add items",
		tickTick: "Tick items",
		untitled: "Checklist",
		denied: "You may not read this checklist.",
		unavailable: "This checklist cannot be shown now.",
		loading: "Loading…",
		empty: "No items yet.",
		newItem: "New item",
		newItemPlaceholder: "A new item",
		add: "Add",
	},
});
