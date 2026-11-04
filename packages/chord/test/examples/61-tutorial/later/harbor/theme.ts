// The Harbor theme's data, shared by its web and terminal facets: colours by role, a corner radius for the page, a
// 256-colour muted tone for terminals.

import type { Theme } from "@todo/app/v1";

export const harbor: Theme = {
	id: "harbor",
	name: "Harbor",
	mode: "dark",
	colors: {
		accent: "#f2a65a",
		bg: "#12232e",
		fg: "#d8e2e8",
		muted: "#6b8796",
		error: "#e5676b",
		warning: "#e9c46a",
		success: "#7fb685",
	},
	web: { radius: "6px" },
	tui: { muted: "66" },
};
