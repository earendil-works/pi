// A second dark theme for pages, as a single-file plugin (it imports only the app's API).

import { defineFacet, Themes } from "@board/app/v1";

export default defineFacet((_host, self) =>
	self.contribute(Themes, {
		id: "midnight",
		name: "Midnight",
		mode: "dark",
		colors: {
			accent: "#7aa2f7",
			bg: "#1a1b26",
			fg: "#c0caf5",
			muted: "#565f89",
			error: "#f7768e",
			warning: "#e0af68",
			success: "#9ece6a",
		},
	}),
);
