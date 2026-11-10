// The worker base (decision "Workers start from the base code the server booted with"): a worker kind's entry and the
// base code it imports, bundled once by esbuild when the workers component builds it (the kit: right after the server
// listens), as the surfaces build their base bundles. Every worker of the kind is forked from this snapshot, so an edit
// of the app's source while the server runs reaches workers only through a restart of the server. Packages installed under `node_modules` (native
// addons, packages reading their own files) and Node builtins stay external: Node loads them at each fork from where
// the build resolved them. Everything else, the app's files and workspace packages linked into `node_modules`, is
// inlined. The bundle is split at each dynamic `import()` esbuild can follow: the entry module and the chunks it imports
// statically load at each fork, a lazily imported module (pi-ai's provider APIs and the packages they import) only when
// the worker imports it. Every file is an ES module with its source map beside it (`<name>.mjs.map`, linked from its
// last line; an inline one would be text of the module V8 keeps, and Node keeps its decoded copy), written at the first
// fork (`file()`; a handle never forked writes nothing) into one private directory its handle owns and removes: a new temporary one, or
// one the caller names (the kit's per kind in the data directory: the same path at every start, so Node's compile cache
// knows the files). Every file the build read is recorded with its bytes' hash
// (`BaseInputs`), as its one read hands them to esbuild.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Loader, type Plugin } from "esbuild";
import { type BaseInputs, readRecorded, recordedSources } from "../plugins/base-inputs.ts";
import { conditionsOf } from "../surfaces/bundle.ts";

/** A worker kind's bundled base: the file workers are forked from, and the files it was built from. */
export interface WorkerBase {
	/** The files esbuild read for it with their bytes' hashes: the app's base code, a file differing outdates it. */
	readonly inputs: BaseInputs;
	/**
	 * The entry module's path, its chunks beside it: written at the first call, and again when a temporary-file cleaner
	 * removed one of them (into a new temporary directory, or its named one).
	 */
	file(): string;
	/** Removes the bundle's directory, when `file()` wrote it. */
	remove(): void;
}

/**
 * What `import.meta.url`, `.dirname` and `.filename` (and a CommonJS file's free `__dirname` and `__filename`) become: a
 * module's own constants (`moduleLocations`).
 */
const MODULE_URL = "__chordModuleUrl";
const MODULE_DIRNAME = "__chordModuleDirname";
const MODULE_FILENAME = "__chordModuleFilename";

/** The entry module's name in the bundle's directory (`worker.mjs`); chunks are named `<name>-<hash>.mjs`. */
const ENTRY_NAME = "worker";

/**
 * Bundles `entry` for workers forked with `execArgv` (its `--conditions` resolve imports as the child's Node would),
 * in memory; its files are written at the handle's first `file()`, into `dir` (a private directory the handle owns:
 * emptied first, removed by `remove`) or, without one, a new temporary directory. Rejects with esbuild's failure.
 */
export async function buildWorkerBase(entry: string, execArgv: readonly string[], dir?: string): Promise<WorkerBase> {
	// Built as if at the file system's root: the source map's paths relative to it, made absolute by `sourceRoot`.
	const root = parse(resolve(entry)).root;
	const inputs = new Map<string, string>();
	const result = await build({
		entryPoints: [{ in: entry, out: ENTRY_NAME }],
		// One flat directory: every chunk imports the others as `./<name>`, and the source maps' paths stay relative to
		// the root.
		outdir: root,
		entryNames: "[name]",
		chunkNames: "[name]-[hash]",
		outExtension: { ".js": ".mjs" },
		// A dynamic `import()` esbuild can follow becomes a chunk Node loads only when the worker imports it, with the
		// packages it imports: inlined into one module, every lazily imported module would load and run at each fork.
		splitting: true,
		write: false,
		bundle: true,
		format: "esm",
		platform: "node",
		// Node's own resolution: the child's conditions, `main` only (no `module` condition or field).
		conditions: conditionsOf(execArgv),
		mainFields: ["main"],
		// Every imported module runs, as Node runs it: `sideEffects: false` and pure annotations drop none (the entry's
		// own package may say it, as Chord's does).
		ignoreAnnotations: true,
		// Function and class names as the source has them (`name` stays what unbundled code sees).
		keepNames: true,
		sourcemap: "linked",
		sourcesContent: false,
		sourceRoot: pathToFileURL(root).href,
		// A CommonJS file of the base code requires through this (each chunk has its own); external packages by their
		// absolute paths.
		banner: {
			js: 'import { createRequire as __chordCreateRequire } from "node:module"; const require = __chordCreateRequire(import.meta.url);',
		},
		define: {
			"import.meta.url": MODULE_URL,
			"import.meta.dirname": MODULE_DIRNAME,
			"import.meta.filename": MODULE_FILENAME,
			__dirname: MODULE_DIRNAME,
			__filename: MODULE_FILENAME,
		},
		plugins: [installedPackages(), moduleLocations(inputs), recordedSources(inputs)],
		logLevel: "silent",
	});
	const files = result.outputFiles.map((output) => ({ name: basename(output.path), contents: output.contents }));
	return new BundleFiles(files, inputs, dir);
}

/**
 * The files of the static import graph of Node code started from `entry` with `conditions`, with their bytes' hashes: a
 * best-effort scan (esbuild bundles it only to record what it reads; nothing is written or run). It sees the literal
 * imports of the graph, including lazy literal `import()`s Node may never run (conservative: such a file's edit asks
 * for a restart); a computed `import(x)` and modules a loader provides are not seen, and an import that does not
 * resolve (an inactive optional import of a missing file or package, a loader's scheme) is left out. It resolves as
 * Node does: the conditions, `main`, no `tsconfig.json` `paths`; installed packages are left out (never compared).
 * Rejects with esbuild's failure for anything else (a file it cannot parse).
 */
export async function nodeBaseInputs(entry: string, conditions: readonly string[]): Promise<BaseInputs> {
	const inputs = new Map<string, string>();
	await build({
		entryPoints: [entry],
		write: false,
		bundle: true,
		format: "esm",
		platform: "node",
		conditions: [...conditions],
		mainFields: ["main"],
		// Node reads no tsconfig.json: its `paths` would resolve an import elsewhere than Node does.
		tsconfigRaw: "{}",
		// Every file the bundle reaches is read, as Node would load it; the output is dropped.
		ignoreAnnotations: true,
		plugins: [staticGraph(), recordedSources(inputs)],
		logLevel: "silent",
	});
	return inputs;
}

/**
 * The scan's resolution (`nodeBaseInputs`): an import resolving under a `node_modules` directory and one that does not
 * resolve at all are left out (external); the rest resolves as esbuild does.
 */
function staticGraph(): Plugin {
	return {
		name: "chord-node-base-static-graph",
		setup(builder) {
			builder.onResolve({ filter: /.*/ }, async (args) => {
				if (args.pluginData === RESOLVING || args.kind === "entry-point" || isBuiltin(args.path)) return undefined;
				const resolved = await builder.resolve(args.path, {
					kind: args.kind,
					importer: args.importer,
					resolveDir: args.resolveDir,
					pluginData: RESOLVING,
				});
				const outside =
					resolved.errors.length > 0 || resolved.external || resolved.path.split(sep).includes("node_modules");
				return outside ? { path: args.path, external: true } : resolved;
			});
		},
	};
}

/** Marks the resolver's own call, so the plugin does not resolve it again. */
const RESOLVING = Symbol("chord.worker-base.resolving");

/**
 * Keeps a package resolved under a `node_modules` directory external, by its absolute file (a URL for an `import`, a
 * path for a `require`): the bundle lives elsewhere, so a bare specifier would not resolve from it. A workspace
 * package resolves to its real path outside `node_modules` and is inlined. A specifier that does not resolve is left to
 * esbuild (an error, or a warning for a `require` in a `try`).
 */
function installedPackages(): Plugin {
	return {
		name: "chord-worker-installed-packages",
		setup(builder) {
			builder.onResolve({ filter: /^[^./]/ }, async (args) => {
				if (args.pluginData === RESOLVING || isBuiltin(args.path)) return undefined;
				const resolved = await builder.resolve(args.path, {
					kind: args.kind,
					importer: args.importer,
					resolveDir: args.resolveDir,
					pluginData: RESOLVING,
				});
				if (resolved.errors.length > 0) return undefined;
				if (!resolved.path.split(sep).includes("node_modules")) return resolved;
				const path = args.kind.startsWith("require") ? resolved.path : pathToFileURL(resolved.path).href;
				return { path, external: true };
			});
		},
	};
}

/** Whether a source names its own location. */
const LOCATIONS = /import\.meta|__dirname|__filename/;

/** The loaders of the source files `moduleLocations` reads: every extension its filter matches. */
const LOADERS: Readonly<Record<string, Loader>> = {
	".js": "js",
	".mjs": "js",
	".cjs": "js",
	".jsx": "jsx",
	".ts": "ts",
	".mts": "ts",
	".cts": "ts",
	".tsx": "tsx",
};

/**
 * Keeps `import.meta.url`, `.dirname` and `.filename`, `__dirname` and `__filename` naming each module's source file, not
 * the bundle (base code finds files beside it this way: p2's plugins directory): a module using them gets its own
 * constants, which `define` puts in their place. Declared on its first line, so the source map's lines stay. It reads
 * (and records in `inputs`) every source file of its extensions, which it hands to esbuild changed or as read.
 */
function moduleLocations(inputs: Map<string, string>): Plugin {
	return {
		name: "chord-worker-module-locations",
		setup(builder) {
			builder.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/ }, async (args) => {
				if (args.namespace !== "file") return undefined;
				const bytes = await readRecorded(args.path, inputs);
				// The filter matched one of `LOADERS`' extensions.
				const loader = LOADERS[extname(args.path)]!;
				const source = bytes.toString("utf8");
				if (!LOCATIONS.test(source)) return { contents: bytes, loader };
				const constants = [
					[MODULE_URL, pathToFileURL(args.path).href],
					[MODULE_DIRNAME, dirname(args.path)],
					[MODULE_FILENAME, args.path],
				].map(([name, value]) => `${name} = ${JSON.stringify(value)}`);
				return { contents: `var ${constants.join(", ")};${source}`, loader };
			});
		},
	};
}

/** One output file of the bundle: its name in the bundle's directory and its contents. */
interface BundleFile {
	readonly name: string;
	readonly contents: Uint8Array;
}

/**
 * The bundle as files: written at the first `file()` (a named directory is shared with later starts: a handle whose
 * owner closed before forking must never touch it) into its named directory (emptied first: the files of an earlier
 * build go) or a new private temporary one, again when one of them is gone; the directory removed with the handle.
 */
class BundleFiles implements WorkerBase {
	readonly inputs: BaseInputs;
	readonly #files: readonly BundleFile[];
	readonly #named: string | undefined;
	/** Where the files were written; `undefined` before the first `file()` and after `remove`. */
	#dir: string | undefined;

	constructor(files: readonly BundleFile[], inputs: BaseInputs, named: string | undefined) {
		this.#files = files;
		this.inputs = inputs;
		this.#named = named;
	}

	file(): string {
		// A long-running server's temporary directory may be cleaned (systemd-tmpfiles, macOS), a chunk no worker
		// imported for a while first: a fork needs all of them. A temporary directory is a new one, never the old name:
		// another user may have made that one since (a named directory is the app's own, private).
		const dir = this.#dir;
		if (dir !== undefined && this.#files.every((file) => existsSync(join(dir, file.name)))) {
			return join(dir, `${ENTRY_NAME}.mjs`);
		}
		this.remove();
		return join(this.#write(), `${ENTRY_NAME}.mjs`);
	}

	remove(): void {
		if (this.#dir !== undefined) rmSync(this.#dir, { recursive: true, force: true });
		this.#dir = undefined;
	}

	/** Writes the bundle's files into its private directory (mode 0700, each file 0600); the directory. */
	#write(): string {
		let dir = this.#named;
		if (dir === undefined) dir = mkdtempSync(join(tmpdir(), "chord-worker-"));
		else {
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		for (const file of this.#files) writeFileSync(join(dir, file.name), file.contents, { mode: 0o600 });
		this.#dir = dir;
		return dir;
	}
}
