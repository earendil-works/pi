// App layout: the sidebar and main slots, the drawer on phones, Back/Forward navigation.

import { contribute, defineFacet } from "@p2/app/v1";
import {
	AppLayout,
	ComposerState,
	closeLayers,
	getNavigation,
	NavigationContext,
	Slots,
	startNavigation,
} from "@p2/app/v1/web";
import { useEffect } from "react";

function App() {
	const nav = getNavigation();
	useEffect(() => startNavigation(), []);
	useEffect(() => {
		const wide = window.matchMedia("(min-width: 900px)");
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
	});
});
