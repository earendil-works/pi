// App layout: the sidebar and main slots, the drawer on phones, Back/Forward navigation; the layout's and the theme's
// commands of the command menu (commands.tsx).

import { contribute, defineFacet } from "@p2/app/v1";
import {
	AppLayout,
	CommandPages,
	Commands,
	ComposerState,
	closeLayers,
	getNavigation,
	NavigationContext,
	SIDEBAR_DOCKS,
	Slots,
	startNavigation,
} from "@p2/app/v1/web";
import { useEffect } from "react";
import { SHELL_COMMANDS, SHELL_PAGES } from "./commands.tsx";

function App() {
	const nav = getNavigation();
	useEffect(() => startNavigation(), []);
	useEffect(() => {
		const wide = window.matchMedia(SIDEBAR_DOCKS);
		const change = () => {
			if (wide.matches && nav.route.layers.at(-1)?.kind === "drawer") closeLayers();
		};
		change();
		wide.addEventListener("change", change);
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented && nav.route.layers.at(-1)?.kind === "drawer") {
				event.preventDefault();
				closeLayers();
			}
		};
		window.addEventListener("keydown", key);
		return () => {
			wide.removeEventListener("change", change);
			window.removeEventListener("keydown", key);
		};
	}, [nav]);
	return (
		<NavigationContext.Provider value={nav}>
			<ComposerState>
				<AppLayout />
			</ComposerState>
		</NavigationContext.Provider>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-shell", (self) => {
		self.contribute(Slots, { app: App });
		self.contribute(Commands, SHELL_COMMANDS);
		self.contribute(CommandPages, SHELL_PAGES);
	});
});
