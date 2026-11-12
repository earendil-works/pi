// p2's plugins on Chord v2's plugin component: plugin directories under plugins/, each facet of kind `server`,
// `worker` or `web` built on its own against p2's plugin API (`@p2/app/v1`) and the packages a facet shares with its
// host: server and worker facets evaluated with this process's instances of them (host-packages.ts), web facets served
// to pages by Chord's web surface (server.ts) and evaluated there with the page's (src/hosts/web/main.tsx). TUI facets
// stay in p2's own bundle (bundles.ts).

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createPlugins, type Plugins, type PluginsError } from "@earendil-works/chord/plugins";
import { WEB_PREFIX } from "@earendil-works/chord/surfaces";
import * as discordJs from "discord.js";
import * as api from "../api/v1/index.ts";
import * as apiNode from "../api/v1/node.ts";
import * as apiServer from "../api/v1/server.ts";
import { SHARED_PACKAGES, WORKER_PACKAGES } from "./host-packages.ts";
import { WEB_PACKAGES } from "./web/packages.ts";

export type PluginName = string;
export type FacetKind = "server" | "worker" | "web" | "tui";
/** Facet files of one plugin (absolute paths). */
export type PluginFacets = Readonly<Partial<Record<FacetKind, string>>>;
export type PluginListing = ReadonlyMap<PluginName, PluginFacets>;

export const PLUGINS_DIRECTORY = fileURLToPath(new URL("../../plugins/", import.meta.url));
/** p2's base code: a change asks for a restart (`plugins.state.base`). */
export const BASE_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const FACET_KINDS = ["server", "worker", "web", "tui"] as const;

/** Where pages load web facets' assets from (the web surface's). */
export const WEB_ASSETS = `${WEB_PREFIX}assets/`;

/** p2's plugin API: one version so far. */
export const API = { name: "@p2/app", versions: ["v1"] } as const;

/**
 * The host packages of server facets: the API's kind-neutral, Node and server modules, the shared packages, and
 * discord.js (the discord plugin's bot; a plugin cannot bundle a package from the app's hoisted node_modules).
 */
export const SERVER_PACKAGES = {
	"@p2/app/v1": api,
	"@p2/app/v1/node": apiNode,
	"@p2/app/v1/server": apiServer,
	"discord.js": discordJs,
	...SHARED_PACKAGES,
};

/** The plugins of `roots`, alphabetical; the first root that has a name wins it. */
export function listRoots(roots: readonly string[]): PluginListing {
	const plugins = new Map<PluginName, PluginFacets>();
	for (const root of roots)
		for (const [name, facets] of listPlugins(root)) if (!plugins.has(name)) plugins.set(name, facets);
	return new Map([...plugins].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A directory listing, alphabetical: every subdirectory with at least one facet file is a plugin (none: no directory). */
export function listPlugins(directory: string = PLUGINS_DIRECTORY): PluginListing {
	const plugins = new Map<PluginName, PluginFacets>();
	if (!existsSync(directory)) return plugins;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const facets: Partial<Record<FacetKind, string>> = {};
		for (const kind of FACET_KINDS) {
			const file = [".ts", ".tsx"]
				.map((extension) => join(directory, entry.name, `${kind}${extension}`))
				.find(existsSync);
			if (file) facets[kind] = file;
		}
		if (Object.keys(facets).length) plugins.set(entry.name, facets);
	}
	return new Map([...plugins].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Exactly the requested plugins (default: all), alphabetical. Missing providers fail at activation, by name. */
export function selectPlugins(listing: PluginListing, requested?: readonly string[]): PluginName[] {
	if (requested === undefined) return [...listing.keys()];
	for (const name of requested) if (!listing.has(name)) throw new Error(`Unknown p2 plugin: ${name}`);
	return [...listing.keys()].filter((name) => requested.includes(name));
}

/** p2's plugin component, and the directory its plugins are found in. */
export type P2Plugins = { readonly plugins: Plugins; readonly directory: string; close(): void };

/**
 * p2's plugins: every plugin of plugins/, or exactly `selection` (tests), and every plugin of the user root `user`
 * (after them: a built-in wins a name, the clash reported). A selection is a copy of plugins/ in which the other
 * plugins keep only their non-facet files: their contracts stay importable, their facets are gone.
 */
export function createP2Plugins(
	selection: readonly string[] | undefined,
	onError: (error: PluginsError) => void,
	context: Context = BACKGROUND_CONTEXT,
	user?: string,
	publicPath: string = WEB_ASSETS,
): P2Plugins {
	const directory = selection === undefined ? PLUGINS_DIRECTORY : selectedCopy(selection);
	const plugins = createPlugins(
		{
			roots: [{ path: directory, required: true }, ...(user === undefined ? [] : [user])],
			api: API,
			base: [BASE_DIRECTORY],
			kinds: {
				server: { platform: "node", hostPackages: Object.keys(SERVER_PACKAGES) },
				worker: { platform: "node", hostPackages: Object.keys(WORKER_PACKAGES) },
				web: { platform: "browser", hostPackages: WEB_PACKAGES },
			},
			publicPath,
			onError,
		},
		context,
	);
	return {
		plugins,
		directory,
		close: () => {
			plugins.close();
			if (directory !== PLUGINS_DIRECTORY) rmSync(dirname(directory), { recursive: true, force: true });
		},
	};
}

/** A copy of plugins/ with only `selection`'s facet files (see `createP2Plugins`). */
function selectedCopy(selection: readonly string[]): string {
	const listing = listPlugins(PLUGINS_DIRECTORY);
	selectPlugins(listing, selection);
	const directory = join(mkdtempSync(join(tmpdir(), "p2-plugins-")), "plugins");
	cpSync(PLUGINS_DIRECTORY, directory, {
		recursive: true,
		filter: (path) => {
			const [name, file, ...rest] = path.slice(PLUGINS_DIRECTORY.length).split("/");
			if (name === undefined || selection.includes(name) || rest.length || file === undefined) return true;
			return !/^(server|worker|web|tui)\.tsx?$/.test(file);
		},
	});
	return directory;
}
