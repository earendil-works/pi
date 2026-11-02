// The Solarized theme's data, shared by its web and terminal facets: colours by role, a radius for the web, a
// 256-colour accent for terminals.

import type { Theme } from "@board/app/v1";

export const solarized: Theme = {
	id: "solarized-dark",
	name: "Solarized Dark",
	mode: "dark",
	colors: {
		accent: "#b58900",
		bg: "#002b36",
		fg: "#839496",
		muted: "#586e75",
		error: "#dc322f",
		warning: "#cb4b16",
		success: "#859900",
	},
	web: { radius: "4px" },
	tui: { muted: "240" },
};
