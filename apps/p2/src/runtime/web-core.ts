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

/** A plugin's section of the Settings window (src/web/SettingsNav.tsx). */
export type SettingsSection = {
	/** The entry's text in the window's list of sections. */
	readonly label: string;
	/** The entry's tooltip. */
	readonly title?: string;
	/** Its place in the list: lower first, equal ones by key. Leave gaps (10, 20, ...) for later plugins. */
	readonly order: number;
	/** Renders the plugin's sheet while the route opens it, as a page of the window or on its own; always mounted. */
	readonly Sheet: ComponentType;
	/** Wraps the entry, rendering it only while the section is available (Voice: with a speech service). */
	readonly Shown?: ComponentType<{ children: ReactNode }>;
};

/**
 * The Settings window's plugin sections, keyed by the name of the sheet layer each opens (`providers`, `envs`, ...):
 * one contribution lists the section and keeps its sheet mounted.
 */
export const SettingsSections = keyedRegistry<SettingsSection>("p2.web-settings-sections");

/** The web's base facet (the page loads it with the plugins' web facets): it serves the web's keyed registries. */
export const webCoreFacet = defineFacet((host) => {
	serveKeyed(host, Slots);
	serveKeyed(host, ComposerExpanders);
	serveKeyed(host, ToolActivities);
	serveKeyed(host, SettingsSections);
});
