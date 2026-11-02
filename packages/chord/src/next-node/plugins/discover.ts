// Discovery (slice 7c §1, slice 12 §2, §4): the plugins under the app's roots, found by listing each root and reading
// only `package.json` files. Each directory at a root's top is a package: the plugins its `chord.plugins` manifest
// lists (decision "`chord.plugins` is a package's manifest of plugins"), else by convention itself when its top has
// facet files, else its subfolders with a `package.json` (a checkout of several), else itself (contracts only). Files
// named `<name>.<kind>.<ext>` at a root's top are single-file plugins grouped by name. Facet files are the ones named
// after the app's facet kinds. Nothing parses or runs plugin code.

import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "../../context/index.ts";
import { isPluginName } from "../../next/host/staging.ts";

/** A root plugins are listed in: a path, or a path marked `required` (a plugin of it failing at `load` is fatal). */
export type PluginRoot = string | { readonly path: string; readonly required?: boolean };

/** A plugin on disk: its name, its real directory, its root, its facet files and npm packages. Plain data. */
export type Plugin = {
	readonly name: string;
	/** Its directory's real path (symlinks followed); a single-file plugin's is its root's. */
	readonly dir: string;
	/** The real path of the root it was found in: relative imports between plugins stay within it. */
	readonly root: string;
	/** Whether its root is required: its build, evaluation or setup failing at `load` rejects the load. */
	readonly required: boolean;
	/** A directory with a `package.json`, or files at a root's top (`hello.server.ts`): host packages only, no files. */
	readonly layout: "directory" | "file";
	/** Its facet files by kind, absolute paths; none for a contracts-only plugin. */
	readonly facets: Readonly<Record<string, string>>;
	/** The packages in its `dependencies`: bundled into the facets that import them. */
	readonly dependencies: readonly string[];
	/** The packages in its `chord.external`: kept external in Node builds, loaded from its `node_modules`. */
	readonly external: readonly string[];
};

/**
 * A root, directory or file that is not a plugin, a plugin left out, or a required root missing, and why; with the
 * root it is in (a required root's problems make `plugins.load` reject).
 */
export type DiscoveryProblem = {
	readonly path: string;
	readonly error: string;
	readonly root: string;
	readonly required: boolean;
};

/** What discovery found: the plugins by name, and the paths it reported. */
export type Discovery = { readonly plugins: readonly Plugin[]; readonly problems: readonly DiscoveryProblem[] };

/** What discovery takes besides the roots: the app's facet kinds (`["server", "worker", "web", "tui"]`). */
export type DiscoveryOptions = { readonly kinds: readonly string[] };

/**
 * Lists every root: its packages' plugins (by their manifests or by convention) and its single-file plugins. Reported,
 * not plugins: a directory without any `package.json`, an invalid one, name or manifest, two files of one facet kind,
 * a name an earlier root (or an earlier entry of the same root) has already; a single-file plugin named like a
 * directory plugin of its root loses to it; a required root that does not exist. A missing root that is not required
 * is empty. Plugins sorted by name.
 */
export async function discoverPlugins(
	roots: readonly PluginRoot[],
	options: DiscoveryOptions,
	context: Context,
): Promise<Discovery> {
	const plugins = new Map<string, Plugin>();
	const problems: DiscoveryProblem[] = [];
	for (const each of roots) {
		const { path, required } = typeof each === "string" ? { path: each, required: false } : each;
		const listed = await listRoot(path, required === true, options.kinds, context);
		problems.push(...listed.problems);
		for (const plugin of listed.plugins) {
			const other = plugins.get(plugin.name);
			if (other !== undefined) {
				const error = `plugin "${plugin.name}" is in ${other.dir} already`;
				problems.push({ path: pathOf(plugin), error, root: plugin.root, required: plugin.required });
				continue;
			}
			plugins.set(plugin.name, plugin);
		}
	}
	const sorted = [...plugins.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return { plugins: sorted, problems };
}

/**
 * The plugins of the package in `dir` (its manifest's folders, or by convention) and its problems, recorded as of
 * `at.root`: what `installPlugin` checks a package with before it moves it into a root.
 */
export async function discoverPackage(dir: string, at: RootContext, context: Context): Promise<Discovery> {
	context.abortSignal?.throwIfAborted();
	const plugins: Plugin[] = [];
	const problems: DiscoveryProblem[] = [];
	for (const each of await packageAt(await realpath(dir), at)) {
		if (each.kind === "plugin") plugins.push(each.plugin);
		else problems.push({ path: each.path, error: each.error, root: at.root, required: at.required });
	}
	return { plugins, problems };
}

/** Where a root's plugins are listed from, and what each records: its root's real path, requiredness, the kinds. */
export type RootContext = { readonly root: string; readonly required: boolean; readonly kinds: readonly string[] };

/** Whether two records of one plugin name the same directory, layout and facet files (else its code moved). */
export function sameFiles(before: Plugin, after: Plugin): boolean {
	const files = (plugin: Plugin) => JSON.stringify(Object.entries(plugin.facets).sort());
	return before.dir === after.dir && before.layout === after.layout && files(before) === files(after);
}

/** The facet files' extensions, in no order of preference: two files of one kind are reported. */
export const FACET_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".mjs"];

/** The plugins of one root, directory plugins first, and its problems. */
async function listRoot(
	path: string,
	required: boolean,
	kinds: readonly string[],
	context: Context,
): Promise<Discovery> {
	const entries = await entriesOf(path);
	if (entries === undefined) {
		if (!required) return { plugins: [], problems: [] };
		return { plugins: [], problems: [{ path, error: "the required root does not exist", root: path, required }] };
	}
	const root = await realpath(path);
	const at = { root, required, kinds };
	const plugins: Plugin[] = [];
	const problems: DiscoveryProblem[] = [];
	for (const dir of entries.dirs) {
		const found = await discoverPackage(dir, at, context);
		plugins.push(...found.plugins);
		problems.push(...found.problems);
	}
	const files = singleFilePlugins(entries.files, at);
	problems.push(...files.problems);
	for (const plugin of files.plugins) {
		const directory = plugins.find((each) => each.name === plugin.name);
		if (directory === undefined) plugins.push(plugin);
		else {
			const error = `plugin "${plugin.name}" is in ${directory.dir} already`;
			problems.push({ path: pathOf(plugin), error, root, required });
		}
	}
	return { plugins, problems };
}

/** A plugin found, or why a directory is none. */
type Found =
	| { readonly kind: "plugin"; readonly plugin: Plugin }
	| { readonly kind: "problem"; readonly path: string; readonly error: string };

/** The plugin's path to report: its directory, or a single-file plugin's first facet file. */
function pathOf(plugin: Plugin): string {
	return plugin.layout === "directory" ? plugin.dir : Object.values(plugin.facets)[0]!;
}

/**
 * The directories (by real path) and plain files directly under `path`, in name order; `undefined` when it does not
 * exist. Hidden entries and `node_modules` are not plugins.
 */
async function entriesOf(path: string): Promise<{ dirs: string[]; files: string[] } | undefined> {
	let names: string[];
	try {
		names = (await readdir(path)).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const dirs: string[] = [];
	const files: string[] = [];
	for (const name of names) {
		if (name.startsWith(".") || name === "node_modules") continue;
		const entry = join(path, name);
		// `stat` follows a symlink: a linked plugin directory is listed by its real path.
		const info = await stat(entry).catch(() => undefined);
		if (info?.isDirectory() === true) dirs.push(await realpath(entry));
		else if (info?.isFile() === true) files.push(name);
	}
	return { dirs, files };
}

/** A package's `package.json`: missing, unreadable (why), or its value (a trust boundary, checked where it is read). */
type Manifest =
	| { readonly kind: "missing" }
	| { readonly kind: "invalid"; readonly error: string }
	| { readonly kind: "read"; readonly value: unknown };

/** The `package.json` of `dir`. */
async function manifestOf(dir: string): Promise<Manifest> {
	try {
		return { kind: "read", value: JSON.parse(await readFile(join(dir, "package.json"), "utf8")) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		return { kind: "invalid", error: `package.json: ${(error as Error).message}` };
	}
}

/**
 * The plugins of the package in `dir` (a real path): its manifest's folders; without a manifest itself when its top
 * has facet files, else its subfolders with a `package.json`, else itself; without a `package.json` its subfolders
 * with one (a checkout of several), else a problem.
 */
async function packageAt(dir: string, at: RootContext): Promise<Found[]> {
	const manifest = await manifestOf(dir);
	if (manifest.kind === "invalid") return [{ kind: "problem", path: dir, error: manifest.error }];
	const value = manifest.kind === "read" ? (manifest.value as { chord?: { plugins?: unknown } } | null) : null;
	const listed = value?.chord?.plugins;
	if (listed !== undefined) return manifestPlugins(dir, listed, at);
	if (manifest.kind === "read" && (await hasFacetFile(dir, at.kinds))) return [await pluginAt(dir, manifest, at)];
	const inner: Found[] = [];
	for (const sub of (await entriesOf(dir))?.dirs ?? []) {
		const found = await manifestOf(sub);
		if (found.kind !== "missing") inner.push(await pluginAt(sub, found, at));
	}
	if (inner.length > 0) return inner;
	if (manifest.kind === "read") return [await pluginAt(dir, manifest, at)];
	return [{ kind: "problem", path: dir, error: "no package.json" }];
}

/** Whether `dir`'s top has a facet file of one of `kinds`. */
async function hasFacetFile(dir: string, kinds: readonly string[]): Promise<boolean> {
	const files = new Set(await readdir(dir));
	return kinds.some((kind) => FACET_EXTENSIONS.some((extension) => files.has(`${kind}${extension}`)));
}

/**
 * The plugins `chord.plugins` (`listed`: folders of the package, as paths, globs and `!` exclusions, as pi's
 * `pi.extensions`) of the package in `dir` names: each a folder with a `package.json` (the package itself when listed
 * as `.`). A manifest that is no list of strings, an entry or a link leaving the package, a listed path that is no
 * directory, and a listing of nothing are problems.
 */
async function manifestPlugins(dir: string, listed: unknown, at: RootContext): Promise<Found[]> {
	const problem = (error: string): Found[] => [
		{ kind: "problem", path: dir, error: `package.json: chord.plugins ${error}` },
	];
	if (!Array.isArray(listed) || !listed.every((each) => typeof each === "string")) {
		return problem("is not a list of plugin folders");
	}
	const entries = listed as readonly string[];
	const excludes = entries.filter((each) => each.startsWith("!")).map((each) => posix(each.slice(1)));
	const folders = new Set<string>();
	for (const entry of entries.filter((each) => !each.startsWith("!"))) {
		const matched = /[*?]/.test(entry) ? await globFolders(dir, posix(entry)) : [resolve(dir, entry)];
		for (const folder of matched) {
			const rest = relative(dir, folder);
			if (rest.startsWith("..") || isAbsolute(rest)) return problem(`"${entry}" leaves the package`);
			if (!excludes.some((exclude) => matchesGlob(posix(rest) || ".", exclude))) folders.add(folder);
		}
	}
	// One plugin inside another's directory would make the outer one's imports of it its own files, not copies.
	const sorted = [...folders].sort();
	for (const inner of sorted) {
		const outer = sorted.find((folder) => insideDir(folder, inner));
		if (outer !== undefined) {
			const listed = (folder: string) => posix(relative(dir, folder)) || ".";
			return problem(`lists "${listed(inner)}" inside the listed "${listed(outer)}"`);
		}
	}
	if (folders.size === 0) return problem("lists no plugin folder");
	const found: Found[] = [];
	for (const folder of sorted) {
		const info = await stat(folder).catch(() => undefined);
		if (info?.isDirectory() !== true) {
			found.push({ kind: "problem", path: folder, error: "listed in chord.plugins, not a directory" });
			continue;
		}
		const real = await realpath(folder);
		const rest = relative(dir, real);
		if (rest.startsWith("..") || isAbsolute(rest)) {
			found.push({ kind: "problem", path: folder, error: "listed in chord.plugins, links out of the package" });
			continue;
		}
		found.push(await pluginAt(real, await manifestOf(real), at));
	}
	return found;
}

/** `path` with `/` separators and no leading `./` (as manifests and globs write paths). */
function posix(path: string): string {
	return path.split(sep).join("/").replace(/^\.\//, "");
}

/** Whether `path` lies inside directory `dir` (both absolute). */
function insideDir(dir: string, path: string): boolean {
	const rest = relative(dir, path);
	return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest);
}

/**
 * Whether the `/`-separated `path` matches the glob `pattern`: `*` and `?` within one segment, `**` across segments
 * (`node:path`'s `matchesGlob` is experimental in Node 22, Chord's floor); anything else literal.
 */
function matchesGlob(path: string, pattern: string): boolean {
	let source = "";
	for (let at = 0; at < pattern.length; at++) {
		const char = pattern[at]!;
		if (pattern.startsWith("**/", at)) {
			source += "(?:.*/)?";
			at += 2;
		} else if (pattern.startsWith("**", at)) {
			source += ".*";
			at += 1;
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`).test(path);
}

/** How deep a glob of `chord.plugins` looks for folders. */
const GLOB_DEPTH = 6;

/** The folders under `dir` (hidden ones and `node_modules` skipped, `GLOB_DEPTH` deep) whose path matches `pattern`. */
async function globFolders(dir: string, pattern: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (at: string, depth: number): Promise<void> => {
		if (depth > GLOB_DEPTH) return;
		let entries: Dirent[];
		try {
			entries = await readdir(at, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const path = join(at, entry.name);
			if (matchesGlob(posix(relative(dir, path)), pattern)) found.push(path);
			await walk(path, depth + 1);
		}
	};
	await walk(dir, 1);
	return found;
}

/** The plugin in `dir` (its real path) with its `package.json` read as `manifest`, or why it is none. */
async function pluginAt(dir: string, manifest: Manifest, at: RootContext): Promise<Found> {
	const problem = (error: string): Found => ({ kind: "problem", path: dir, error });
	if (manifest.kind === "missing") return problem("no package.json");
	if (manifest.kind === "invalid") return problem(manifest.error);
	// A trust boundary: a plugin's own `package.json`.
	const { name, dependencies, chord } = (manifest.value ?? {}) as {
		readonly name?: unknown;
		readonly dependencies?: unknown;
		readonly chord?: { readonly external?: unknown };
	};
	if (typeof name !== "string" || !isPluginName(name)) {
		return problem(`package.json: ${JSON.stringify(name)} is not a valid plugin name`);
	}
	const external = chord?.external ?? [];
	if (!Array.isArray(external) || !external.every((each) => typeof each === "string")) {
		return problem("package.json: chord.external is not a list of package names");
	}
	const files = new Set(await readdir(dir));
	const facets: Record<string, string> = {};
	for (const kind of at.kinds) {
		const named = FACET_EXTENSIONS.map((extension) => `${kind}${extension}`).filter((file) => files.has(file));
		if (named.length > 1) return problem(`two ${kind} facets: ${named.join(", ")}`);
		if (named.length === 1) facets[kind] = join(dir, named[0]!);
	}
	const packages = typeof dependencies === "object" && dependencies !== null ? Object.keys(dependencies) : [];
	const plugin: Plugin = {
		name,
		dir,
		root: at.root,
		required: at.required,
		layout: "directory",
		facets,
		dependencies: packages,
		external,
	};
	return { kind: "plugin", plugin };
}

/**
 * The single-file plugins among a root's top files: `<name>.<kind>.<ext>` with `<kind>` one of the app's kinds and
 * `<ext>` a facet extension, grouped by `<name>` (an unscoped plugin name, else reported; two files of one kind
 * reported). Other files are not plugins.
 */
function singleFilePlugins(
	files: readonly string[],
	at: RootContext,
): { readonly plugins: readonly Plugin[]; readonly problems: readonly DiscoveryProblem[] } {
	const groups = new Map<string, Map<string, string[]>>();
	for (const file of files) {
		const parsed = singleFileName(file, at.kinds);
		if (parsed === undefined) continue;
		const kinds = groups.get(parsed.name) ?? new Map<string, string[]>();
		groups.set(parsed.name, kinds);
		kinds.set(parsed.kind, [...(kinds.get(parsed.kind) ?? []), file]);
	}
	const plugins: Plugin[] = [];
	const problems: DiscoveryProblem[] = [];
	for (const [name, kinds] of groups) {
		const first = join(at.root, [...kinds.values()][0]![0]!);
		if (!isPluginName(name) || name.startsWith("@")) {
			problems.push({ path: first, error: `"${name}" is not a valid unscoped plugin name`, ...rootOf(at) });
			continue;
		}
		const twice = [...kinds].find(([, named]) => named.length > 1);
		if (twice !== undefined) {
			problems.push({ path: first, error: `two ${twice[0]} facets: ${twice[1].join(", ")}`, ...rootOf(at) });
			continue;
		}
		const facets = Object.fromEntries([...kinds].map(([kind, [file]]) => [kind, join(at.root, file!)]));
		const record = { root: at.root, required: at.required, dependencies: [], external: [] };
		plugins.push({ name, dir: at.root, layout: "file", facets, ...record });
	}
	return { plugins, problems };
}

/** The plugin name and kind of a single-file plugin's file name (`hello.server.ts`), or `undefined` for another file. */
function singleFileName(
	file: string,
	kinds: readonly string[],
): { readonly name: string; readonly kind: string } | undefined {
	const extension = FACET_EXTENSIONS.find((each) => file.endsWith(each));
	if (extension === undefined) return undefined;
	const stem = file.slice(0, -extension.length);
	const dot = stem.lastIndexOf(".");
	if (dot <= 0) return undefined;
	const kind = stem.slice(dot + 1);
	return kinds.includes(kind) ? { name: stem.slice(0, dot), kind } : undefined;
}

/** A problem's root fields for a root's context. */
function rootOf(at: RootContext): { readonly root: string; readonly required: boolean } {
	return { root: at.root, required: at.required };
}
