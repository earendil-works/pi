// The web page's base facet and the web's own registries: plain TypeScript (no JSX), so tests load it too.
import type { ComponentType, ReactNode } from "react";
import { defineFacet, keyedRegistry, serveKeyed } from "./chord.ts";
import { ComposerExpanders } from "./composer.ts";

/** React components by slot name ("app", "sidebar", "main"), contributed by web facets. */
export const Slots = keyedRegistry<ComponentType<{ children?: ReactNode }>>("p2.web-slots");

/** The web's base facet (the page loads it with the plugins' web facets): it serves the web's keyed registries. */
export const webCoreFacet = defineFacet((host) => {
	serveKeyed(host, Slots);
	serveKeyed(host, ComposerExpanders);
});
