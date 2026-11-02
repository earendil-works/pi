// Evaluating (slice 7c §3): a built script run with `vm.Script` in this context under a stable filename per (plugin,
// kind, digest), given the `require` that answers its external imports: the host packages (one instance per process),
// this component's `pluginFile` bound to the plugin's directory, and `chord.external` packages and Node builtins from
// the plugin's own `node_modules`. No module map and no cache: an old facet's closures are collected once nothing holds
// them.

import { createRequire, isBuiltin } from "node:module";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Script } from "node:vm";
import type { Principal } from "../../next/data/index.ts";
import type { Facet } from "../../next/host/index.ts";
import type { BuiltFacet } from "./build.ts";
import type { Plugin } from "./discover.ts";
import { registerScript } from "./stack.ts";

/**
 * The host packages by specifier, each what Node's `require` would give: a CommonJS package's exports, an ESM
 * package's namespace (`import * as`), wrapped once so default and named imports both work.
 */
export type HostPackages = Readonly<Record<string, unknown>>;

/** What `evaluateFacet` takes besides the script: the host packages and the plugin it was built from. */
export type EvaluateOptions = { readonly hostPackages: HostPackages; readonly plugin: Plugin };

/** A built script, as evaluation takes it. */
export type BuiltScript = Extract<BuiltFacet, { readonly kind: "script" }>;

/**
 * Evaluates `built` and returns its facet (its default export). Throws what the script throws while it is evaluated,
 * an import its `require` does not answer, or a declaration error when its default export is not a facet.
 */
export function evaluateFacet<P extends Principal = Principal>(built: BuiltScript, options: EvaluateOptions): Facet<P> {
	const { plugin, hostPackages } = options;
	const where = `plugin "${plugin.name}" (${built.facet})`;
	const file = plugin.facets[built.facet] ?? `${built.facet}.js`;
	const filename = `/chord-plugins/${plugin.name}/${basename(file)}?${built.digest}`;
	// The script is one function expression: its value when run.
	const wrapper = new Script(built.source, { filename }).runInThisContext() as (
		require: (specifier: string) => unknown,
		module: { exports: unknown },
		exports: unknown,
	) => void;
	const module = { exports: {} as unknown };
	let facet: unknown;
	try {
		wrapper(requireFor(plugin, built, hostPackages, where), module, module.exports);
		// A trust boundary: plugin code; its default export is checked to be a facet (a getter of it may throw too).
		facet = (module.exports as { readonly default?: unknown } | null)?.default;
		if (typeof facet !== "object" || facet === null || typeof (facet as { setup?: unknown }).setup !== "function") {
			throw new Error(`${where}: its default export is not a facet (defineFacet)`);
		}
	} catch (error) {
		// Its stack maps while the error lives (an import-time throw names the plugin's line).
		if (typeof error === "object" && error !== null) registerScript(filename, built.source, plugin.dir, error);
		throw error;
	}
	registerScript(filename, built.source, plugin.dir, facet);
	return facet as Facet<P>;
}

/**
 * Inside a facet script, the absolute path of `path`, a file of the facet's own plugin (`..` out of its directory
 * refused); evaluation gives each facet its own. Imported anywhere else, it throws.
 */
export function pluginFile(path: string): string {
	throw new Error(`pluginFile("${path}"): only a plugin's facet script, evaluated by the plugins component, has one`);
}

/** The one specifier of this component a script imports (`pluginFile`): external always, answered per facet. */
export const PLUGINS_SPECIFIER = "@earendil-works/chord/next/plugins";

/**
 * The `require` a facet script of `plugin` takes (`where` names the facet in its errors). A computed `require(x)`
 * cannot be seen at build, so it refuses here what the build refuses to imports: another version of the app's API than
 * the script imports (or, when it imports none, than the first one it requires), Chord itself under an app's API, and
 * for a single-file plugin anything but host packages.
 */
function requireFor(
	plugin: Plugin,
	built: BuiltScript,
	hostPackages: HostPackages,
	where: string,
): (specifier: string) => unknown {
	let fromPlugin: NodeJS.Require | undefined;
	let plugins: { readonly pluginFile: (path: string) => string } | undefined;
	// The facet's API version: the one its build saw, else the first one required (one facet, one version).
	let version = built.api?.version;
	return (specifier) => {
		const refused = refusedAtRun(built, version, specifier);
		if (refused !== undefined) throw new Error(`${where}: "${specifier}": ${refused}`);
		version ??= versionOf(built, specifier);
		if (Object.hasOwn(hostPackages, specifier)) return interop(hostPackages[specifier]);
		if (specifier === PLUGINS_SPECIFIER) {
			plugins ??= { pluginFile: (path) => fileOf(plugin, path) };
			return plugins;
		}
		if (plugin.layout === "file") {
			throw new Error(`${where}: "${specifier}": a single-file plugin requires only host packages`);
		}
		if (isBuiltin(specifier) || plugin.external.includes(packageName(specifier))) {
			fromPlugin ??= createRequire(join(plugin.dir, "package.json"));
			return fromPlugin(specifier);
		}
		throw new Error(
			`${where}: "${specifier}" is not a host package, a Node builtin or one of its chord.external packages`,
		);
	};
}

/**
 * Why a script built against the app's API, using API `version` so far, may not require `specifier` (the build's API
 * rules), or `undefined`.
 */
function refusedAtRun(built: BuiltScript, version: string | undefined, specifier: string): string | undefined {
	const { api } = built;
	if (api === undefined || specifier === PLUGINS_SPECIFIER) return undefined;
	if (packageName(specifier) === "@earendil-works/chord") return "plugins import Chord through the app's API";
	const required = versionOf(built, specifier);
	if (required === undefined || version === undefined || required === version) return undefined;
	return `this script uses ${api.name}/${version}: one facet uses one version of the API`;
}

/** The API version `specifier` names (`v3` of `@acme/app/v3/web`), when the script was built against an API. */
function versionOf(built: BuiltScript, specifier: string): string | undefined {
	const { api } = built;
	if (api === undefined || (specifier !== api.name && !specifier.startsWith(`${api.name}/`))) return undefined;
	return specifier.slice(api.name.length + 1).split("/")[0];
}

/** The package a bare specifier names: `@scope/name` or `name`, without a subpath. */
export function packageName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** The absolute path of `path` inside `plugin`'s directory; one out of it is refused, and so is every one of a single-file plugin. */
function fileOf(plugin: Plugin, path: string): string {
	if (plugin.layout === "file") {
		throw new Error(`pluginFile("${path}"): single-file plugin "${plugin.name}" has no directory of its own`);
	}
	const file = resolve(plugin.dir, path);
	const rest = relative(plugin.dir, file);
	if (rest.startsWith("..") || isAbsolute(rest)) {
		throw new Error(`pluginFile("${path}"): outside the directory of plugin "${plugin.name}"`);
	}
	return file;
}

/** ESM namespaces wrapped for a CommonJS script, by namespace: one wrapper per namespace, held as long as it is. */
const wrapped = new WeakMap<object, object>();

/**
 * A host package as a CommonJS script imports it: an ESM namespace wrapped once with `__esModule` (so esbuild's interop
 * reads its `default` for a default import, its names for named ones), any other value as it is.
 */
function interop(value: unknown): unknown {
	if (typeof value !== "object" || value === null || Object.prototype.toString.call(value) !== "[object Module]") {
		return value;
	}
	let made = wrapped.get(value);
	if (made === undefined) {
		made = { ...value, __esModule: true };
		wrapped.set(value, made);
	}
	return made;
}
