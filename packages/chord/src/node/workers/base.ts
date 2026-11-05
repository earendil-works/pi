// The worker base (decision "Workers start from the base code the server booted with"): a worker kind's entry and the
// base code it imports, bundled once by esbuild when the workers component is created, as the surfaces build their base
// bundles at start. Every worker of the kind is forked from this snapshot, so an edit of the app's source while the
// server runs reaches workers only through a restart of the server. Packages installed under `node_modules` (native
// addons, packages reading their own files) and Node builtins stay external: Node loads them at each fork from where
// the build resolved them. Everything else, the app's files and workspace packages linked into `node_modules`, is
// inlined. The bundle is split at each dynamic `import()` esbuild can follow: the entry module and the chunks it imports
// statically load at each fork, a lazily imported module (pi-ai's provider APIs and the packages they import) only when
// the worker imports it. Every file is an ES module with an inline source map, in one private temporary directory.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Loader, type Plugin } from "esbuild";
import { metafileInputs } from "../surfaces/bundle.ts";

/** A worker kind's bundled base: the file workers are forked from, and the files it was built from. */
export interface WorkerBase {
	/** The files esbuild read for it (absolute): the app's base code a change of which outdates it. */
	readonly inputs: readonly string[];
	/**
	 * The entry module's path, its chunks beside it; all written again into a new private directory when a
	 * temporary-file cleaner removed one of them.
	 */
	file(): string;
	/** Removes the bundle's directory. */
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
 * Bundles `entry` for workers forked with `execArgv` (its `--conditions` resolve imports as the child's Node would).
 * Rejects with esbuild's failure: the server does not start with a broken worker base.
 */
export async function buildWorkerBase(entry: string, execArgv: readonly string[]): Promise<WorkerBase> {
	// Built as if at the file system's root: the source map's paths relative to it, made absolute by `sourceRoot`.
	const root = parse(resolve(entry)).root;
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
		sourcemap: "inline",
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
		plugins: [installedPackages(), moduleLocations()],
		logLevel: "silent",
		metafile: true,
	});
	const files = result.outputFiles.map((output) => ({ name: basename(output.path), contents: output.contents }));
	return new BundleFiles(files, metafileInputs(result.metafile));
}

/** The conditions of `--conditions=<name>`, `--conditions <name>`, `-C <name>` and `-C=<name>` in `execArgv`. */
function conditionsOf(execArgv: readonly string[]): string[] {
	const conditions: string[] = [];
	for (let i = 0; i < execArgv.length; i++) {
		const flag = execArgv[i]!;
		const inline = /^(?:--conditions|-C)=(.*)$/.exec(flag);
		if (inline !== null) conditions.push(inline[1]!);
		else if ((flag === "--conditions" || flag === "-C") && i + 1 < execArgv.length) conditions.push(execArgv[++i]!);
	}
	return conditions;
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
 * constants, which `define` puts in their place. Declared on its first line, so the source map's lines stay.
 */
function moduleLocations(): Plugin {
	return {
		name: "chord-worker-module-locations",
		setup(builder) {
			builder.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/ }, async (args) => {
				const source = await readFile(args.path, "utf8");
				if (!LOCATIONS.test(source)) return undefined;
				const constants = [
					[MODULE_URL, pathToFileURL(args.path).href],
					[MODULE_DIRNAME, dirname(args.path)],
					[MODULE_FILENAME, args.path],
				].map(([name, value]) => `${name} = ${JSON.stringify(value)}`);
				// The filter matched one of `LOADERS`' extensions.
				const loader = LOADERS[extname(args.path)]!;
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

/** The bundle as files: written into a private temporary directory, again into a new one when one of them is gone. */
class BundleFiles implements WorkerBase {
	readonly inputs: readonly string[];
	readonly #files: readonly BundleFile[];
	#dir = "";

	constructor(files: readonly BundleFile[], inputs: readonly string[]) {
		this.#files = files;
		this.inputs = inputs;
		this.#write();
	}

	file(): string {
		// A long-running server's temporary directory may be cleaned (systemd-tmpfiles, macOS), a chunk no worker
		// imported for a while first: a fork needs all of them. A new directory, never the old name: another user may
		// have made that one since.
		if (!this.#files.every((file) => existsSync(join(this.#dir, file.name)))) {
			this.remove();
			this.#write();
		}
		return join(this.#dir, `${ENTRY_NAME}.mjs`);
	}

	remove(): void {
		rmSync(this.#dir, { recursive: true, force: true });
	}

	/** Writes the bundle's files into a new private directory (mode 0700, each file 0600). */
	#write(): void {
		this.#dir = mkdtempSync(join(tmpdir(), "chord-worker-"));
		for (const file of this.#files) writeFileSync(join(this.#dir, file.name), file.contents, { mode: 0o600 });
	}
}
