// The web page's base facet and the web's own registries: plain TypeScript (no JSX), so tests load it too.
import type { ComponentType, ReactNode } from "react";
import type { ToolActivity } from "../web/activity/model.ts";
import type { Route } from "../web/navigation.ts";
import { defineFacet, type Host, keyedRegistry, serveKeyed } from "./chord.ts";
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

/**
 * What the command menu's commands act on: a type owned by a plugin ("session"), an id
 * that type's owner parses, and the chip's text: `kind` ("Session"), then `label` ("Fix the build"; may be empty).
 */
export type CommandTarget = {
	readonly type: string;
	readonly id: string;
	readonly kind: string;
	readonly label: string;
};

/** A command of the command menu (Cmd+K): listed in the menu, runnable by id (shortcuts, the Recent group). */
export type Command = {
	/** Sentence case verb phrase, `…` when it opens a page ("Archive session", "Change model…"). */
	readonly title: string;
	/** The group's heading, one or two words ("Session"). */
	readonly group: string;
	/** The group's place in the list: lower first, equal ones by heading. Leave gaps (10, 20, ...). */
	readonly order: number;
	readonly icon?: ComponentType;
	/** More words the menu's filter matches ("delete" for Archive). */
	readonly keywords?: readonly string[];
	/** Shown only for targets of these types (["session"]); for every target and none when absent. */
	readonly target?: readonly string[];
	/** Hidden from guests. */
	readonly owner?: true;
	/** Wraps the row, rendering it only while the command applies (Restore: while the session is archived). */
	readonly Shown?: ComponentType<{ children: ReactNode }>;
	readonly action: CommandAction;
};

/** What a command does: run (after the menu closed), or open one of `CommandPages`. */
export type CommandAction =
	| { readonly kind: "run"; run(ctx: CommandContext): void | Promise<void> }
	| { readonly kind: "page"; readonly page: string };

/** What a command runs with: the Chord host (to hold what it calls), the menu's target, the route after the close. */
export type CommandContext = { readonly host: Host; readonly target?: CommandTarget; readonly route: Route };

/** A page of the command menu: a list of live data (sessions, models) its `Body` renders with `CommandMenu.Row`s. */
export type CommandPage = {
	/** Names the page's scope, shown as a crumb after the target chip ("Models"). */
	readonly label: string;
	/** What its input searches ("Search models…"). */
	readonly placeholder: string;
	/** What the menu says while the page has no rows ("Type the new title"); "No results" when absent. */
	readonly empty?: string;
	readonly Body: ComponentType;
};

/**
 * Rows a plugin adds to the menu's root while the query is not empty (sessions matching their title): `Results`
 * renders `CommandMenu.Row`s, which the menu shows in the group `group`, placed by `order` as commands' groups are.
 */
export type CommandSearch = { readonly group: string; readonly order: number; readonly Results: ComponentType };

/** The command menu's commands by id (`<plugin>.<verb>`, "sessions.archive"). */
export const Commands = keyedRegistry<Command>("p2.web-commands");

/** The command menu's pages by name ("sessions", "models"), opened by a command with a `page` action. */
export const CommandPages = keyedRegistry<CommandPage>("p2.web-command-pages");

/** Rows plugins add to the command menu's root results while the reader types. */
export const CommandSearches = keyedRegistry<CommandSearch>("p2.web-command-searches");

/** The web's base facet (the page loads it with the plugins' web facets): it serves the web's keyed registries. */
export const webCoreFacet = defineFacet((host) => {
	serveKeyed(host, Slots);
	serveKeyed(host, ComposerExpanders);
	serveKeyed(host, ToolActivities);
	serveKeyed(host, SettingsSections);
	serveKeyed(host, Commands);
	serveKeyed(host, CommandPages);
	serveKeyed(host, CommandSearches);
});
