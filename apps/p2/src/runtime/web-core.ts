// The web page's base facet and the web's own registries: plain TypeScript (no JSX), so tests load it too.
import type { ComponentType, ReactNode } from "react";
import type { ToolActivity } from "../web/activity/model.ts";
import { defineFacet, keyedRegistry, serveKeyed } from "./chord.ts";
import { ComposerExpanders } from "./composer.ts";

/** React components by slot name ("app", "sidebar", "main"), contributed by web facets. */
export const Slots = keyedRegistry<ComponentType<{ children?: ReactNode }>>("p2.web-slots");

/**
 * How a tool's calls show in the chat, by tool name: contributed by the web facet of the plugin that owns the tool (no
 * tool is known to p2's own UI; a tool without one gets the generic look).
 */
export const ToolActivities = keyedRegistry<ToolActivity>("p2.web-tool-activities");

/** The web's base facet (the page loads it with the plugins' web facets): it serves the web's keyed registries. */
export const webCoreFacet = defineFacet((host) => {
	serveKeyed(host, Slots);
	serveKeyed(host, ComposerExpanders);
	serveKeyed(host, ToolActivities);
});
