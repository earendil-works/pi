// The Settings window's own sections, over settings.json, in the order its list shows them: shared by the window and
// the command menu's settings page.

/** The own sections; their ids are the window layer's locators. */
export const OWN_SECTIONS = [
	{ id: "general", label: "General" },
	{ id: "models", label: "Models" },
	{ id: "agent", label: "Agent" },
	{ id: "requests", label: "Requests" },
	{ id: "compaction", label: "Compaction" },
] as const;

export type OwnSection = (typeof OWN_SECTIONS)[number]["id"];
