// Building (slice 7c §2): one facet of one plugin as one script, by esbuild from cold. Its own files, files of other
// discovered plugins (copies) and its npm `dependencies` are inlined; host packages, this component, `chord.external`
// packages and Node builtins stay external, answered at evaluation by the `require` the script takes. The result is
// plain data, the same value a worker or a page evaluates where it runs; a failed build is a result, never a throw.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { type BuildFailure, build, type Plugin as EsbuildPlugin, type Loader, type Message } from "esbuild";
import type { Context } from "../../context/index.ts";
import type { Plugin } from "./discover.ts";
import { inlineSourceMap } from "./stack.ts";

/** What `buildFacet` takes besides the plugin and the kind. */
export type BuildOptions = {
	/** The host packages' specifiers (`@earendil-works/chord/next`, `react`, `react/jsx-runtime`, `@app/core`): external. */
	readonly hostPackages: readonly string[];
	/** Where the script runs: Node (a server, a worker, a TUI) or a browser (a page). */
	readonly platform: "node" | "browser";
	/** The discovered plugins: a file of one of them may be imported (a copy). */
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
	  }
	| { readonly kind: "failed"; readonly plugin: string; readonly facet: string; readonly errors: readonly string[] };

/** The one specifier of this component a script imports (`pluginFile`): external always, answered per facet. */
export const PLUGINS_SPECIFIER = "@earendil-works/chord/next/plugins";

/** What a free `__dirname` and `__filename` become in a build: names no script has, found again by `freeGlobals`. */
const GLOBAL_MARKERS = { __dirname: "__chord_plugin_dirname", __filename: "__chord_plugin_filename" };

/**
 * Builds `plugin`'s facet of `kind` (one esbuild build from cold): a script wrapped as `(function (require, module,
 * exports) { … })`, or the errors that refuse it (an import the rules of §2 do not admit, a syntax error, `import.meta`,
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
	const entry = plugin.facets[kind];
	if (entry === undefined) return failed([`plugin "${plugin.name}" has no ${kind} facet`]);
	context.abortSignal?.throwIfAborted();
	const rules = new ImportRules(plugin, options);
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

/** Where a resolved file lies, from the plugin being built: its own source, another plugin's (a copy), a package. */
type Place =
	| { readonly kind: "own" }
	| { readonly kind: "copied"; readonly plugin: Plugin }
	| { readonly kind: "package" }
	| { readonly kind: "outside" };

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

/**
 * The import rules of one build (§2's table) as an esbuild plugin, and what the build read: every file of a plugin
 * hashed as it is handed to esbuild (the exact bytes built, not a later read racing a save), and the copied files.
 */
class ImportRules {
	readonly plugin: EsbuildPlugin;
	readonly #own: Plugin;
	readonly #others: readonly Plugin[];
	readonly #options: BuildOptions;
	readonly #hostPackages: ReadonlySet<string>;
	readonly #inputs = new Map<string, string>();
	readonly #copied = new Set<string>();

	constructor(own: Plugin, options: BuildOptions) {
		this.#own = own;
		this.#others = (options.plugins ?? []).filter((each) => each.dir !== own.dir);
		this.#options = options;
		this.#hostPackages = new Set(options.hostPackages);
		this.plugin = {
			name: "chord-plugin-imports",
			setup: (builder) => {
				builder.onResolve({ filter: /.*/ }, async (args) => {
					// The plugin's files are resolved here, the entry too: esbuild then gives them no Node module type
					// (`"type": "module"`), whose interop would read a whole host package for a default import instead
					// of honouring the `__esModule` an ESM namespace is wrapped with (§3).
					if (args.kind === "entry-point") return { path: resolve(own.dir, args.path) };
					if (args.pluginData === RESOLVING) return undefined;
					const resolved = await this.#resolve(args.path, args.importer, args.kind);
					if (resolved.kind === "error") return { errors: [{ text: resolved.text }] };
					if (resolved.kind === "external") return { path: args.path, external: true };
					if (resolved.kind === "default") return undefined;
					const found = await builder.resolve(resolved.path, {
						kind: args.kind,
						importer: args.importer,
						resolveDir: args.resolveDir,
						pluginData: RESOLVING,
					});
					if (found.errors.length > 0) return { errors: found.errors };
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

	/**
	 * What an import of `specifier` from `importer` becomes: external, refused, esbuild's own resolution (a package of
	 * the plugin's `dependencies`, or anything a package imports), or a path esbuild resolves and the rules check.
	 */
	async #resolve(
		specifier: string,
		importer: string,
		kind: string,
	): Promise<
		| { readonly kind: "external" }
		| { readonly kind: "default" }
		| { readonly kind: "path"; readonly path: string; readonly asset: boolean }
		| { readonly kind: "error"; readonly text: string }
	> {
		const browser = this.#options.platform === "browser";
		if (kind === "dynamic-import") {
			return {
				kind: "error",
				text: `import("${specifier}"): a plugin script has no dynamic import (${PLUGIN_FILE_HINT})`,
			};
		}
		if (specifier === PLUGINS_SPECIFIER || this.#hostPackages.has(specifier)) return { kind: "external" };
		if (isBuiltin(specifier)) {
			if (!browser) return { kind: "external" };
			return { kind: "error", text: `"${specifier}": a Node builtin in a browser build` };
		}
		if (specifier.endsWith("?url")) {
			if (browser) return { kind: "path", path: specifier.slice(0, -"?url".length), asset: true };
			return { kind: "error", text: `"${specifier}": assets by URL are for browser builds (${PLUGIN_FILE_HINT})` };
		}
		const from = this.#place(importer);
		if (from.kind === "package") return { kind: "default" };
		if (specifier.startsWith(".") || isAbsolute(specifier)) return { kind: "path", path: specifier, asset: false };
		if (from.kind === "copied") {
			return { kind: "error", text: `"${specifier}": ${copiedRule(from.plugin)}` };
		}
		const name = packageName(specifier);
		if (this.#own.external.includes(name)) {
			if (!browser) return { kind: "external" };
			return { kind: "error", text: `"${specifier}": chord.external packages are for Node builds` };
		}
		if (this.#own.dependencies.includes(name)) return { kind: "default" };
		return {
			kind: "error",
			text: `"${specifier}": neither a host package nor in the dependencies of plugin "${this.#own.name}"`,
		};
	}

	/**
	 * Why the file `path` (resolved from a relative import in `importer`) may not be inlined: outside the plugin and
	 * every other discovered plugin, or, from a copied file, outside that file's own plugin; `undefined` when it may (a
	 * file of another plugin is recorded as copied).
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
		return `"${specifier}": outside the plugin (base code is reached through a host package, packages through dependencies)`;
	}

	/** Where `path` lies. */
	#place(path: string): Place {
		if (path.split(sep).includes("node_modules")) return { kind: "package" };
		if (inside(this.#own.dir, path)) return { kind: "own" };
		const other = this.#others.find((each) => inside(each.dir, path));
		return other === undefined ? { kind: "outside" } : { kind: "copied", plugin: other };
	}
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

/** The package a bare specifier names: `@scope/name` or `name`, without a subpath. */
export function packageName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
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
