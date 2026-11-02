// Building (slice 7c §2, slice 12 §1-§4): one facet of one plugin as one script, by esbuild from cold. Its own files,
// files of other plugins of its root imported by relative path (copies; decision "Contracts come from where the
// plugin's code came from") and its npm `dependencies` (through their `exports`) are inlined; host packages, this
// component, `chord.external` packages and Node builtins stay external, answered at evaluation by the `require` the
// script takes. Every import is checked by the file it resolves to: a per-kind file only for its kind, the app's API
// only at a listed version the kind provides, one version per facet, never Chord directly. The result is plain data,
// the same value a worker or a page evaluates where it runs; a failed build is a result, never a throw.

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { type BuildFailure, build, type Plugin as EsbuildPlugin, type Loader, type Message } from "esbuild";
import type { Context } from "../../context/index.ts";
import { discoverPackage, type Plugin } from "./discover.ts";
import { PLUGINS_SPECIFIER, packageName } from "./evaluate.ts";
import { inlineSourceMap } from "./stack.ts";

/**
 * The app's API (slice 12 §1): the package plugins import it as and the versions it provides, newest first
 * (`{ name: "@acme/app", versions: ["v3", "v2"] }`). Its modules are host packages (`@acme/app/v3`, `@acme/app/v3/web`).
 */
export type AppApi = { readonly name: string; readonly versions: readonly string[] };

/** What `buildFacet` takes besides the plugin and the kind. */
export type BuildOptions = {
	/** The host packages' specifiers (`@acme/app/v3`, `@acme/app/v3/web`, `react`, `react/jsx-runtime`): external. */
	readonly hostPackages: readonly string[];
	/** Where the script runs: Node (a server, a worker, a TUI) or a browser (a page). */
	readonly platform: "node" | "browser";
	/** The app's API: its imports checked by version and kind, Chord refused. Without one, host packages as listed. */
	readonly api?: AppApi;
	/** The app's facet kinds: a file named `<name>.<kind>.<ext>` is one of that kind, refused in a facet of another. */
	readonly kinds?: readonly string[];
	/** The discovered plugins: a file of a directory plugin of the same root may be imported by relative path (a copy). */
	readonly plugins?: readonly Plugin[];
	/** Where the app serves a browser build's assets: the URL prefix their imports evaluate to (`/` by default). */
	readonly publicPath?: string;
};

/** A file a build read, with the hash of the bytes it handed esbuild (the watcher's inputs). */
export type BuildInput = { readonly file: string; readonly hash: string };

/** A built facet: its script and what it used, or the build's errors. Plain data. */
export type BuiltFacet =
	| {
			readonly kind: "script";
			readonly plugin: string;
			readonly facet: string;
			/** The wrapped CommonJS script, minified, with an inline source map whose sources are relative to the plugin. */
			readonly source: string;
			/** A hash of `source`: the same on every machine and checkout for the same files. */
			readonly digest: string;
			/** Every plugin file it read (its own and copied ones; not packages), absolute paths, with their hashes. */
			readonly inputs: readonly BuildInput[];
			/** The files of other plugins inlined into it, absolute paths. */
			readonly copied: readonly string[];
			/** A browser build's stylesheet, when it imports CSS. */
			readonly css?: { readonly name: string; readonly text: string };
			/** A browser build's assets, by content-hashed file name. */
			readonly assets: readonly { readonly name: string; readonly bytes: Uint8Array }[];
			/**
			 * The app's API the build checked against and the version the script imports (when it imports one):
			 * evaluation refuses other versions and Chord to a computed `require` as the build did to imports.
			 */
			readonly api?: { readonly name: string; readonly version: string | undefined };
	  }
	| { readonly kind: "failed"; readonly plugin: string; readonly facet: string; readonly errors: readonly string[] };

/** What a free `__dirname` and `__filename` become in a build: names no script has, found again by `freeGlobals`. */
const GLOBAL_MARKERS = { __dirname: "__chord_plugin_dirname", __filename: "__chord_plugin_filename" };

/**
 * Builds `plugin`'s facet of `kind` (one esbuild build from cold): a script wrapped as `(function (require, module,
 * exports) { … })`, or the errors that refuse it (an import the rules do not admit, a syntax error, `import.meta`,
 * `__dirname`, `__filename`, a literal dynamic `import("x")`, a top-level `await`), each naming its file and line. A
 * computed `import(x)` becomes a call of the script's `require`.
 */
export async function buildFacet(
	plugin: Plugin,
	kind: string,
	options: BuildOptions,
	context: Context,
): Promise<BuiltFacet> {
	const failed = (errors: readonly string[]): BuiltFacet => ({
		kind: "failed",
		plugin: plugin.name,
		facet: kind,
		errors,
	});
	const named = plugin.facets[kind];
	if (named === undefined) return failed([`plugin "${plugin.name}" has no ${kind} facet`]);
	context.abortSignal?.throwIfAborted();
	// A facet file may be a link: its real file must be the plugin's, and of no other kind.
	const entry = await realpath(named);
	const rules = new ImportRules(plugin, kind, entry, options, context);
	const wrongEntry = rules.checkEntry(named, entry);
	if (wrongEntry !== undefined) return failed([wrongEntry]);
	const browser = options.platform === "browser";
	let result: Awaited<ReturnType<typeof build>>;
	try {
		result = await build({
			entryPoints: [entry],
			absWorkingDir: plugin.dir,
			// Nothing is written: the directory only makes the source map's paths relative to the plugin.
			outdir: plugin.dir,
			entryNames: "[name]-[hash]",
			assetNames: "[name]-[hash]",
			publicPath: options.publicPath ?? "/",
			write: false,
			bundle: true,
			format: "cjs",
			platform: options.platform,
			target: browser ? "es2022" : "node22",
			minify: true,
			legalComments: "none",
			sourcemap: "inline",
			// Positions only: a stack is mapped to files and lines, never shown their text.
			sourcesContent: false,
			// Ignore any tsconfig.json: TypeScript is stripped, JSX compiled with the automatic React runtime.
			tsconfigRaw: "{}",
			jsx: "automatic",
			banner: { js: "(function (require, module, exports) {" },
			footer: { js: "})" },
			// `import.meta` is refused here; a free `__dirname` or `__filename` becomes a marker found in the output below
			// (esbuild reports no `import.meta` it substituted itself).
			define: GLOBAL_MARKERS,
			logOverride: { "empty-import-meta": "error" },
			// A computed `import(x)` (a literal one is refused below) goes through the facet's `require`, which names the
			// facet when it does not answer; `vm.Script` has no loader for a real one.
			supported: { "dynamic-import": false },
			logLevel: "silent",
			plugins: [rules.plugin],
		});
	} catch (error) {
		return failed(
			((error as BuildFailure).errors ?? [{ text: String(error) }]).map((each) => describe(plugin, each)),
		);
	}
	// Never written: esbuild hands the outputs back.
	const files = result.outputFiles!;
	const script = files.find((file) => file.path.endsWith(".js"))!;
	const css = files.find((file) => file.path.endsWith(".css"));
	const source = script.text;
	const globals = freeGlobals(source);
	if (globals.length > 0) return failed(globals);
	const mixed = rules.mixedVersions();
	if (mixed !== undefined) return failed([mixed]);
	const api = options.api === undefined ? undefined : { name: options.api.name, version: rules.version() };
	return {
		kind: "script",
		plugin: plugin.name,
		facet: kind,
		source,
		digest: createHash("sha256").update(source).digest("hex"),
		inputs: rules.inputs(),
		copied: rules.copied(),
		...(css === undefined ? {} : { css: { name: basename(css.path), text: css.text } }),
		assets: files
			.filter((file) => file !== script && file !== css)
			.map((file) => ({ name: relative(plugin.dir, file.path), bytes: file.contents })),
		...(api === undefined ? {} : { api }),
	};
}

/** Where a build error points for what a plugin script cannot have. */
const PLUGIN_FILE_HINT = `a file of the plugin is read through pluginFile(path) from "${PLUGINS_SPECIFIER}"`;

/** The error of a script using `import.meta`, `__dirname` or `__filename`. */
const NO_MODULE_IDENTITY = `import.meta.url, __dirname and __filename are not available in a plugin script (${PLUGIN_FILE_HINT})`;

/**
 * The errors for every free `__dirname` and `__filename` in the built `source` (their markers), each at its file, line
 * and column through the script's source map.
 */
function freeGlobals(source: string): string[] {
	// Most scripts have none: no map parsed for them.
	if (!source.includes("__chord_plugin_")) return [];
	const map = inlineSourceMap(source);
	if (map === undefined) return [];
	const errors: string[] = [];
	for (const [line, text] of source.split("\n").entries()) {
		for (const match of text.matchAll(/__chord_plugin_(?:dirname|filename)/g)) {
			const entry = map.findEntry(line, match.index);
			if (!("originalSource" in entry)) continue;
			errors.push(
				`${entry.originalSource}:${entry.originalLine + 1}:${entry.originalColumn + 1}: ${NO_MODULE_IDENTITY}`,
			);
		}
	}
	return errors;
}

/**
 * Where a resolved file lies (a real path), from the plugin being built: its own source, another plugin's of its root (a
 * copy), a package of its own `node_modules`, a plugin of another root, or no plugin.
 */
type Place =
	| { readonly kind: "own" }
	| { readonly kind: "copied"; readonly plugin: Plugin }
	| { readonly kind: "package" }
	| { readonly kind: "other-root"; readonly plugin: Plugin }
	| { readonly kind: "outside" };

/** What an import resolves to before the rules check the file: external, refused, a package, or a plugin file. */
type Resolution =
	| { readonly kind: "external" }
	| { readonly kind: "package" }
	| { readonly kind: "path"; readonly path: string; readonly asset: boolean }
	| { readonly kind: "error"; readonly text: string };

/** What only a browser build imports: stylesheets and wasm assets. */
const BROWSER_ONLY = new Set([".css", ".wasm"]);

/** Marks esbuild's resolution the rules ask for themselves, so they do not judge it again. */
const RESOLVING = Symbol("chord.plugins.resolving");

/** How the source files a build reads are loaded, by extension (packages load as esbuild decides). */
const LOADERS: Readonly<Record<string, Loader>> = {
	".ts": "ts",
	".mts": "ts",
	".cts": "ts",
	".tsx": "tsx",
	".js": "js",
	".mjs": "js",
	".cjs": "js",
	".jsx": "jsx",
	".json": "json",
	".css": "css",
	".wasm": "file",
};

/** What an asset import's resolution carries to its load (the `file` loader whatever its extension). */
const ASSET = Symbol("chord.plugins.asset");

/** Chord's package: never imported by plugins of an app with an API (only its `/next/plugins` for `pluginFile`). */
const CHORD_PACKAGE = "@earendil-works/chord";

/**
 * The import rules of one build (§2's table, slice 12 §1-§4) as an esbuild plugin, and what the build read: every file
 * of a plugin hashed as it is handed to esbuild (the exact bytes built, not a later read racing a save), the copied
 * files, the importer of each file (for the chain a per-kind refusal names) and the API versions imported.
 */
class ImportRules {
	readonly plugin: EsbuildPlugin;
	readonly #own: Plugin;
	readonly #kind: string;
	/** The facet file's real path. */
	readonly #entry: string;
	/** The plugin's own packages' directory: every package file inlined lies in it. */
	readonly #modules: string;
	/** The other directory plugins: a single-file plugin's files are no one's to import. */
	readonly #others: readonly Plugin[];
	readonly #options: BuildOptions;
	readonly #hostPackages: ReadonlySet<string>;
	readonly #inputs = new Map<string, string>();
	readonly #copied = new Set<string>();
	/** The first importer of every file resolved, by file. */
	readonly #importers = new Map<string, string>();
	/** The API versions imported, each with its first importer. */
	readonly #versions = new Map<string, string>();
	/** Whether a directory of a package has a `package.json`, and whether it has a `chord` field, by directory. */
	readonly #manifests = new Map<string, Promise<"chord" | "plain" | "none">>();
	/** The plugin folders a `chord` package lists, by its directory. */
	readonly #listed = new Map<string, Promise<ReadonlySet<string>>>();
	readonly #context: Context;

	constructor(own: Plugin, kind: string, entry: string, options: BuildOptions, context: Context) {
		this.#context = context;
		this.#own = own;
		this.#kind = kind;
		this.#entry = entry;
		this.#modules = join(own.dir, "node_modules");
		this.#others = (options.plugins ?? []).filter((each) => each.dir !== own.dir && each.layout === "directory");
		this.#options = options;
		this.#hostPackages = new Set(options.hostPackages);
		this.plugin = {
			name: "chord-plugin-imports",
			setup: (builder) => {
				builder.onResolve({ filter: /.*/ }, async (args) => {
					// The plugin's files are resolved here, the entry too: esbuild then gives them no Node module type
					// (`"type": "module"`), whose interop would read a whole host package for a default import instead
					// of honouring the `__esModule` an ESM namespace is wrapped with (§3).
					if (args.kind === "entry-point") return { path: this.#entry };
					if (args.pluginData === RESOLVING) return undefined;
					const resolved = this.#resolve(args.path, args.importer, args.kind);
					if (resolved.kind === "error") return { errors: [{ text: resolved.text }] };
					if (resolved.kind === "external") return { path: args.path, external: true };
					const found = await builder.resolve(resolved.kind === "path" ? resolved.path : args.path, {
						kind: args.kind,
						importer: args.importer,
						resolveDir: args.resolveDir,
						pluginData: RESOLVING,
					});
					if (found.errors.length > 0) return { errors: found.errors };
					// A module a package's `browser` field disables: as esbuild resolved it.
					if (found.namespace !== "file") return found;
					// esbuild resolves links: `found.path` is the real file.
					if (resolved.kind === "package") {
						if (this.#place(found.path).kind !== "package") {
							const at = this.#shown(found.path);
							return {
								errors: [{ text: `"${args.path}": resolves outside the plugin's node_modules (${at})` }],
							};
						}
						// A package that is plugin code (a `chord` field: a plugin, or a repository of several) keeps
						// the per-kind rule; an ordinary library names its files as it likes (`pdf.worker.mjs`).
						const code = await this.#pluginCode(found.path);
						if (code !== undefined) {
							if (!this.#importers.has(found.path)) this.#importers.set(found.path, args.importer);
							const refused = this.#checkKind(found.path, args.path, code.top);
							if (refused !== undefined) return { errors: [{ text: refused }] };
						}
						return { path: found.path, sideEffects: found.sideEffects, suffix: found.suffix };
					}
					if (found.path !== this.#entry && !this.#importers.has(found.path)) {
						this.#importers.set(found.path, args.importer);
					}
					const refused = this.#checkKind(found.path, args.path);
					if (refused !== undefined) return { errors: [{ text: refused }] };
					if (options.platform === "node" && BROWSER_ONLY.has(extname(found.path))) {
						return { errors: [{ text: `"${args.path}": stylesheets and assets are for browser builds` }] };
					}
					const checked = this.#checkFile(found.path, args.importer, args.path);
					if (checked !== undefined) return { errors: [{ text: checked }] };
					return { path: found.path, pluginData: resolved.asset ? ASSET : undefined };
				});
				builder.onLoad({ filter: /.*/ }, async (args) => {
					if (args.namespace !== "file") return undefined;
					const asset = args.pluginData === ASSET;
					const loader = asset ? "file" : LOADERS[extname(args.path)];
					if (loader === undefined || this.#place(args.path).kind === "package") return undefined;
					const contents = await readFile(args.path);
					this.#inputs.set(args.path, createHash("sha256").update(contents).digest("hex"));
					return { contents, loader, resolveDir: dirname(args.path) };
				});
			},
		};
	}

	/** Every plugin file read, sorted by path. */
	inputs(): BuildInput[] {
		return [...this.#inputs].map(([file, hash]) => ({ file, hash })).sort((a, b) => (a.file < b.file ? -1 : 1));
	}

	/** The other plugins' files inlined, sorted. */
	copied(): string[] {
		return [...this.#copied].sort();
	}

	/** The API version the script imports, if it imports one (one version: `mixedVersions` refuses two). */
	version(): string | undefined {
		return [...this.#versions.keys()][0];
	}

	/**
	 * Why the facet file `named` (its real path `entry`) may not be built: a link out of the plugin (a single-file
	 * plugin's out of its root's top), or to a file of another kind; `undefined` when it may.
	 */
	checkEntry(named: string, entry: string): string | undefined {
		const own = this.#own.layout === "file" ? dirname(entry) === this.#own.dir : inside(this.#own.dir, entry);
		if (!own) return `${basename(named)}: the facet file links out of its plugin (${entry})`;
		const fileKind = this.#kindOf(entry);
		if (fileKind === undefined || sameKind(fileKind, this.#kind)) return undefined;
		return `${basename(named)}: links to a ${fileKind} file (${this.#shown(entry)}), not a ${this.#kind} facet`;
	}

	/** The error of a facet importing two API versions (both named with an importer), or `undefined`. */
	mixedVersions(): string | undefined {
		if (this.#versions.size < 2) return undefined;
		const name = this.#options.api!.name;
		const seen = [...this.#versions]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([version, importer]) => `${name}/${version} (${this.#shown(importer)})`);
		return `one facet imports one version of ${name}: this one imports ${seen.join(" and ")}`;
	}

	/**
	 * What an import of `specifier` from `importer` becomes: external, refused, a package esbuild resolves (one of the
	 * plugin's `dependencies`, or anything a package imports) or a path esbuild resolves and the rules check.
	 */
	#resolve(specifier: string, importer: string, kind: string): Resolution {
		const browser = this.#options.platform === "browser";
		if (kind === "dynamic-import") {
			return {
				kind: "error",
				text: `import("${specifier}"): a plugin script has no dynamic import (${PLUGIN_FILE_HINT})`,
			};
		}
		if (specifier === PLUGINS_SPECIFIER) return { kind: "external" };
		const api = this.#apiImport(specifier, importer);
		if (api !== undefined) return api;
		if (this.#hostPackages.has(specifier)) return { kind: "external" };
		if (this.#own.layout === "file") {
			const directory = `${this.#own.name}/`;
			return {
				kind: "error",
				text: `"${specifier}": a single-file plugin imports only host packages (the app's API); make it a directory "${directory}" with a package.json`,
			};
		}
		const from = this.#place(importer);
		// A copied file (another plugin's) imports host packages and its own plugin's files only: no builtins either.
		if (from.kind === "copied" && !specifier.startsWith(".") && !isAbsolute(specifier)) {
			return { kind: "error", text: `"${specifier}": ${copiedRule(from.plugin)}` };
		}
		if (isBuiltin(specifier)) {
			if (!browser) return { kind: "external" };
			return { kind: "error", text: `"${specifier}": a Node builtin in a browser build` };
		}
		if (specifier.endsWith("?url")) {
			if (browser) return { kind: "path", path: specifier.slice(0, -"?url".length), asset: true };
			return { kind: "error", text: `"${specifier}": assets by URL are for browser builds (${PLUGIN_FILE_HINT})` };
		}
		if (from.kind === "package") return { kind: "package" };
		if (specifier.startsWith(".") || isAbsolute(specifier)) return { kind: "path", path: specifier, asset: false };
		const name = packageName(specifier);
		if (this.#own.external.includes(name)) {
			if (!browser) return { kind: "external" };
			return { kind: "error", text: `"${specifier}": chord.external packages are for Node builds` };
		}
		if (this.#own.dependencies.includes(name)) return { kind: "package" };
		return {
			kind: "error",
			text: `"${specifier}": neither a host package nor in the dependencies of plugin "${this.#own.name}"`,
		};
	}

	/**
	 * An import of the app's API or of Chord when the app has an API (slice 12 §1): a listed version the kind provides
	 * is external (its version recorded); an unlisted version, a module the kind lacks and Chord itself are refused.
	 * `undefined` for any other specifier.
	 */
	#apiImport(specifier: string, importer: string): Resolution | undefined {
		const api = this.#options.api;
		if (api === undefined) return undefined;
		const newest = `${api.name}/${api.versions[0]}`;
		if (packageName(specifier) === CHORD_PACKAGE) {
			return {
				kind: "error",
				text: `"${specifier}": plugins import Chord through the app's API ("${newest}"), never directly`,
			};
		}
		if (specifier !== api.name && !specifier.startsWith(`${api.name}/`)) return undefined;
		const provided = `this app provides ${api.versions.join(", ")}`;
		const version = specifier.slice(api.name.length + 1).split("/")[0]!;
		if (version === "") {
			return { kind: "error", text: `"${specifier}": import a version of the app's API (${provided})` };
		}
		if (!api.versions.includes(version)) {
			return { kind: "error", text: `"${specifier}": ${api.name}/${version} is not available: ${provided}` };
		}
		if (!this.#hostPackages.has(specifier)) {
			return { kind: "error", text: `"${specifier}": not available to ${this.#kind} facets` };
		}
		if (!this.#versions.has(version)) this.#versions.set(version, importer);
		return { kind: "external" };
	}

	/**
	 * Why the plugin file `path` (not a package's: npm packages name files as they like, `pdf.worker.mjs`) may not be
	 * in a facet of this kind: a per-kind file (`contract.web.tsx`) or a facet file (`web.tsx`) of another kind, named
	 * with the chain of imports that reached it; `undefined` when it may.
	 */
	#checkKind(path: string, specifier: string, packageTop?: string): string | undefined {
		const fileKind = this.#kindOf(path, packageTop);
		if (fileKind === undefined || sameKind(fileKind, this.#kind)) return undefined;
		const chain = this.#chainOf(path)
			.map((file) => this.#shown(file))
			.join(" → ");
		return `"${specifier}": a ${fileKind} file, imported into a ${this.#kind} facet (${chain})`;
	}

	/**
	 * The kind of the plugin file `path`, one of the app's kinds (compared without case): a name `<name>.<kind>.<ext>`,
	 * or a facet file `<kind>.<ext>` at the top of a directory plugin (or of the plugin package `packageTop`).
	 */
	#kindOf(path: string, packageTop?: string): string | undefined {
		const parts = basename(path).split(".");
		const kinds = this.#options.kinds ?? [];
		if (parts.length >= 3) return kinds.find((kind) => sameKind(kind, parts[parts.length - 2]!));
		const top =
			dirname(path) === packageTop ||
			[this.#own, ...this.#others].some((each) => each.layout === "directory" && dirname(path) === each.dir);
		return parts.length === 2 && top ? kinds.find((kind) => sameKind(kind, parts[0]!)) : undefined;
	}

	/** The files from the entry to `file`, by their first importers; an import cycle ends the walk. */
	#chainOf(file: string): string[] {
		const chain = [file];
		const seen = new Set(chain);
		for (let at = this.#importers.get(file); at !== undefined && !seen.has(at); at = this.#importers.get(at)) {
			seen.add(at);
			chain.unshift(at);
		}
		return chain;
	}

	/** `file` as an error names it: relative to the plugin's directory. */
	#shown(file: string): string {
		return relative(this.#own.dir, file).split(sep).join("/");
	}

	/**
	 * Why the plugin file `path` (resolved from `importer`'s import of `specifier`) may not be inlined: outside the
	 * plugin's root, in no plugin of it, or, from a copied file, outside that file's own plugin; `undefined` when it may
	 * (another plugin's file of the root is recorded as copied).
	 */
	#checkFile(path: string, importer: string, specifier: string): string | undefined {
		const from = this.#place(importer);
		const to = this.#place(path);
		if (to.kind === "own" && from.kind === "own") return undefined;
		if (to.kind === "copied" && (from.kind === "own" || (from.kind === "copied" && from.plugin === to.plugin))) {
			this.#copied.add(path);
			return undefined;
		}
		if (from.kind === "copied") return `"${specifier}": ${copiedRule(from.plugin)}`;
		if (to.kind === "outside" && inside(this.#own.root, path)) {
			return `"${specifier}": not a file of a plugin in this root`;
		}
		const api = this.#options.api;
		const base = api === undefined ? "a host package" : `the app's API ("${api.name}/${api.versions[0]}")`;
		return `"${specifier}": outside the plugin's root (base code is reached through ${base}, other repositories' plugins through dependencies)`;
	}

	/**
	 * Whether the package file `path` is plugin code: its nearest `package.json` (walking up to the plugin's
	 * `node_modules`) has a `chord` field, or is a plugin folder the next `package.json` above lists in its
	 * `chord.plugins` (a plugin of a repository of several, reached as a dependency); a library (even one nested in a
	 * plugin package) is not. `top` the file's own directory when that is the package's (a facet file there is of its
	 * kind). `undefined` for a library.
	 */
	async #pluginCode(path: string): Promise<{ readonly top: string | undefined } | undefined> {
		let nearest: string | undefined;
		for (let dir = dirname(path); inside(this.#modules, dir); dir = dirname(dir)) {
			const manifest = await this.#manifestIn(dir);
			if (manifest === "none") continue;
			if (nearest === undefined && manifest === "chord") return { top: dir === dirname(path) ? dir : undefined };
			if (nearest === undefined) {
				nearest = dir;
				continue;
			}
			if (manifest === "plain" || !(await this.#listedIn(dir)).has(nearest)) return undefined;
			return { top: nearest === dirname(path) ? nearest : undefined };
		}
		return undefined;
	}

	/** The plugin folders the package in `dir` lists in `chord.plugins` (discovery's reading of it; once per build). */
	#listedIn(dir: string): Promise<ReadonlySet<string>> {
		let listed = this.#listed.get(dir);
		if (listed === undefined) {
			const at = { root: dir, required: false, kinds: this.#options.kinds ?? [] };
			listed = discoverPackage(dir, at, this.#context).then(({ plugins }) => new Set(plugins.map(({ dir }) => dir)));
			this.#listed.set(dir, listed);
		}
		return listed;
	}

	/** What `dir`'s `package.json` is: absent, without a `chord` field, or with one (read once per build). */
	#manifestIn(dir: string): Promise<"chord" | "plain" | "none"> {
		let read = this.#manifests.get(dir);
		if (read === undefined) {
			read = readFile(join(dir, "package.json"), "utf8").then(
				(text) => {
					try {
						// A trust boundary: a package's manifest, read only for its `chord` field.
						return (JSON.parse(text) as { chord?: unknown } | null)?.chord !== undefined ? "chord" : "plain";
					} catch {
						return "plain";
					}
				},
				() => "none",
			);
			this.#manifests.set(dir, read);
		}
		return read;
	}

	/** Where `path` (a real path) lies; a package is one of the plugin's own `node_modules`, any other is outside. */
	#place(path: string): Place {
		if (inside(this.#modules, path)) return { kind: "package" };
		if (inside(this.#own.dir, path)) return { kind: "own" };
		// Another plugin's own packages are no one's to import; a root may itself lie under a `node_modules` (an app
		// installed from npm with its plugins), so only the part below a plugin's directory counts.
		const other = this.#others.find(
			(each) => inside(each.dir, path) && !inside(join(each.dir, "node_modules"), path),
		);
		if (other === undefined) return { kind: "outside" };
		return other.root === this.#own.root ? { kind: "copied", plugin: other } : { kind: "other-root", plugin: other };
	}
}

/** Whether two kind names are the same kind: compared without case (`contract.Web.ts` is a web file). */
function sameKind(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase();
}

/** The rule a copied file broke. */
function copiedRule(plugin: Plugin): string {
	return `a file copied from plugin "${plugin.name}" may import only host packages and files of its own plugin`;
}

/** Whether `path` lies inside directory `dir` (both absolute). */
export function inside(dir: string, path: string): boolean {
	const rest = relative(dir, path);
	return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest);
}

/** One build error as `file:line:column: text`, its file relative to the plugin, with the hint where it applies. */
function describe(plugin: Plugin, message: Message): string {
	let text = message.text;
	if (message.id === "empty-import-meta") {
		text = NO_MODULE_IDENTITY;
	} else if (text.startsWith("Top-level await")) {
		text = "a plugin script has no top-level await (a facet declares synchronously)";
	}
	const location = message.location;
	if (location === null || location === undefined) return text;
	const file = isAbsolute(location.file) ? relative(plugin.dir, location.file) : location.file;
	return `${file}:${location.line}:${location.column + 1}: ${text}`;
}
