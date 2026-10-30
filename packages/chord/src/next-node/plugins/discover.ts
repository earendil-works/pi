// Discovery (slice 7c §1): the plugins under the app's roots, found by listing each root one level deep and reading only
// each directory's `package.json` (its `name`, its `dependencies`, its `chord.external`); its facet files are the ones
// named after the app's facet kinds. Nothing parses or runs plugin code.

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "../../context/index.ts";
import { isPluginName } from "../../next/host/staging.ts";

/** A plugin on disk: its name (its `package.json` name), its real directory, its facet files and npm packages. */
export type Plugin = {
	readonly name: string;
	/** Its directory's real path (symlinks followed). */
	readonly dir: string;
	/** Its facet files by kind, absolute paths; none for a contracts-only plugin. */
	readonly facets: Readonly<Record<string, string>>;
	/** The packages in its `dependencies`: bundled into the facets that import them. */
	readonly dependencies: readonly string[];
	/** The packages in its `chord.external`: kept external in Node builds, loaded from its `node_modules`. */
	readonly external: readonly string[];
};

/** A directory under a root that is not a plugin, or a plugin left out, and why. */
export type DiscoveryProblem = { readonly path: string; readonly error: string };

/** What discovery found: the plugins by name, and the directories it reported. */
export type Discovery = { readonly plugins: readonly Plugin[]; readonly problems: readonly DiscoveryProblem[] };

/** What discovery takes besides the roots: the app's facet kinds (`["server", "worker", "web", "tui"]`). */
export type DiscoveryOptions = { readonly kinds: readonly string[] };

/**
 * Lists every root one level deep: a directory with a valid `package.json` is a plugin (a missing root is empty). A
 * directory without a `package.json`, with an invalid one or an invalid name, with two files of one facet kind, or whose
 * name an earlier root (or an earlier directory of the same root) has already, is reported. Plugins sorted by name.
 */
export async function discoverPlugins(
	roots: readonly string[],
	options: DiscoveryOptions,
	context: Context,
): Promise<Discovery> {
	const plugins = new Map<string, Plugin>();
	const problems: DiscoveryProblem[] = [];
	for (const root of roots) {
		for (const dir of await directoriesOf(root)) {
			context.abortSignal?.throwIfAborted();
			const found = await pluginAt(dir, options.kinds);
			if (found.kind === "problem") {
				problems.push({ path: dir, error: found.error });
				continue;
			}
			const other = plugins.get(found.plugin.name);
			if (other !== undefined) {
				problems.push({ path: dir, error: `plugin "${found.plugin.name}" is in ${other.dir} already` });
				continue;
			}
			plugins.set(found.plugin.name, found.plugin);
		}
	}
	const sorted = [...plugins.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return { plugins: sorted, problems };
}

/** The directories directly under `root`, by real path, in name order; none when `root` does not exist. */
async function directoriesOf(root: string): Promise<string[]> {
	let names: string[];
	try {
		names = (await readdir(root)).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const dirs: string[] = [];
	for (const name of names) {
		// Not plugins: hidden directories and a root's own packages.
		if (name.startsWith(".") || name === "node_modules") continue;
		const path = join(root, name);
		// `stat` follows a symlink: a linked plugin directory is listed by its real path.
		const info = await stat(path).catch(() => undefined);
		if (info?.isDirectory() === true) dirs.push(await realpath(path));
	}
	return dirs;
}

/** The facet files' extensions, in no order of preference: two files of one kind are reported. */
export const FACET_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".mjs"];

/** The plugin in `dir` (its real path), or why it is none. */
async function pluginAt(
	dir: string,
	kinds: readonly string[],
): Promise<
	{ readonly kind: "plugin"; readonly plugin: Plugin } | { readonly kind: "problem"; readonly error: string }
> {
	let manifest: unknown;
	try {
		manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
	} catch (error) {
		const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
		return { kind: "problem", error: missing ? "no package.json" : `package.json: ${(error as Error).message}` };
	}
	// A trust boundary: a plugin's own `package.json`.
	const { name, dependencies, chord } = (manifest ?? {}) as {
		readonly name?: unknown;
		readonly dependencies?: unknown;
		readonly chord?: { readonly external?: unknown };
	};
	if (typeof name !== "string" || !isPluginName(name)) {
		return { kind: "problem", error: `package.json: ${JSON.stringify(name)} is not a valid plugin name` };
	}
	const external = chord?.external ?? [];
	if (!Array.isArray(external) || !external.every((each) => typeof each === "string")) {
		return { kind: "problem", error: "package.json: chord.external is not a list of package names" };
	}
	const files = new Set(await readdir(dir));
	const facets: Record<string, string> = {};
	for (const kind of kinds) {
		const named = FACET_EXTENSIONS.map((extension) => `${kind}${extension}`).filter((file) => files.has(file));
		if (named.length > 1) return { kind: "problem", error: `two ${kind} facets: ${named.join(", ")}` };
		if (named.length === 1) facets[kind] = join(dir, named[0]!);
	}
	const packages = typeof dependencies === "object" && dependencies !== null ? Object.keys(dependencies) : [];
	return { kind: "plugin", plugin: { name, dir, facets, dependencies: packages, external } };
}
