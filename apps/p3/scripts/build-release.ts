// Builds what p3 ships besides its sources (`docs/slices/26-release.md`), into `dist/`: the base code bundled, one
// bundle per process (`main.js`, the command and the server; `worker.js`, a session worker; `supervisor.js`; the base,
// Chord and `ws` inlined where used, so no process loads TypeScript, and a worker or the supervisor none of the
// server's code), the launcher `p3.js`, and the API modules compiled one by one with their declarations
// (`api/v1/`, and what they import of the base), which import Chord from the package's dependency: what a plugin's type
// check and editor resolve. `package.json` names the rest that ships (`files`).
// Run: npm run build (in apps/p3)

import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type BuildOptions, build, type Metafile } from "esbuild";

/** p3's directory in the checkout. */
export const P3 = fileURLToPath(new URL("../", import.meta.url));

/** The repository's root: where esbuild, TypeScript and the workspace packages resolve from. */
export const REPOSITORY = join(P3, "..", "..");

/** The package the bundle leaves to `node_modules`: esbuild runs a binary of its own. */
const EXTERNAL = ["esbuild"];

/**
 * Imports that may stay unresolved: `ws`'s optional native accelerators, which it does without when absent, and
 * `kerberos`, which a provider SDK's proxy agent imports only for a Negotiate proxy (it says to install it otherwise).
 */
const OPTIONAL = ["bufferutil", "utf-8-validate", "kerberos"];

/** What `buildRelease` made. */
export type Built = {
	/** The `dist` directory. */
	readonly dist: string;
	/** Its files, relative, sorted. */
	readonly files: readonly string[];
	/** The bytes of the bundles and the launcher: what a start loads. */
	readonly bytes: number;
};

/** Builds p3's `dist` into `dist` (emptied first): `apps/p3/dist` unless a test names another. */
export async function buildRelease(dist: string = join(P3, "dist")): Promise<Built> {
	const manifest = JSON.parse(await readFile(join(P3, "package.json"), "utf8")) as Manifest;
	checkVersions(manifest, await workspaceVersions(Object.keys(manifest.dependencies)));
	await rm(dist, { recursive: true, force: true });
	await mkdir(dist, { recursive: true });
	const options = bundleOptions(dist);
	// One build per process, no chunk shared between them: a chunk the worker shared with the server would bring it esbuild's JS API,
	// `ws`, HTTP and the server side of Chord's workers (about 1.5 MiB per worker, and its start).
	const bundle = async (name: string, entry: string) =>
		(await build({ ...options, entryPoints: { [name]: join(P3, entry) } })).metafile;
	const [main, worker, supervisor, minimum] = await Promise.all([
		bundle("main", "src/bin.ts"),
		bundle("worker", "src/worker.ts"),
		bundle("supervisor", "src/supervisor.ts"),
		// No banner: the launcher loads it on any Node, before anything else, and it imports nothing.
		build({ ...options, banner: {}, entryPoints: { "minimum-node": join(P3, "src", "minimum-node.ts") } }).then(
			(built) => built.metafile,
		),
	]);
	for (const metafile of [main, worker, supervisor, minimum]) checkExternals(metafile);
	const outputs = { ...main.outputs, ...worker.outputs, ...supervisor.outputs, ...minimum.outputs };
	checkPlacement({ outputs }, "src/install.ts", "main.js");
	checkLean(worker, "worker.js");
	checkLean(supervisor, "supervisor.js");
	await writeFile(join(dist, "p3.js"), LAUNCHER);
	await chmod(join(dist, "p3.js"), 0o755);
	// The API modules, compiled against the workspace's sources: their declarations name Chord's types through the
	// package (`import("@earendil-works/chord")`), as an install resolves them.
	const tsc = join(REPOSITORY, "node_modules", "typescript", "bin", "tsc");
	execFileSync(process.execPath, [tsc, "-p", join(P3, "tsconfig.build.json"), "--outDir", dist], { stdio: "inherit" });
	await copyImportedStyles(dist);
	const files = await readdir(dist, { recursive: true, withFileTypes: true });
	return {
		dist,
		files: files
			.filter((entry) => entry.isFile())
			.map((entry) => relative(dist, join(entry.parentPath, entry.name)))
			.sort(),
		bytes: Object.values(outputs).reduce((sum, output) => sum + output.bytes, LAUNCHER.length),
	};
}

/** A compiled module's import of a stylesheet next to it (`import styles from "./x.module.css"`, `import "./x.css"`). */
const STYLE_IMPORT = /(?:from|import)\s*"(\.{1,2}\/[^"]+\.css)"/g;

/**
 * Copies into `dist` the stylesheets the compiled API modules import (a web module's CSS module): TypeScript emits
 * no CSS, and the page's build in an install resolves them next to the module, as in the source. Each from the
 * checkout's file at the same path; a missing one fails the build.
 */
export async function copyImportedStyles(dist: string): Promise<void> {
	const compiled = (await readdir(dist, { recursive: true, withFileTypes: true })).filter(
		(entry) =>
			entry.isFile() &&
			entry.name.endsWith(".js") &&
			relative(dist, entry.parentPath).split(sep)[0] !== "chunks" &&
			entry.parentPath !== dist,
	);
	for (const entry of compiled) {
		const file = join(entry.parentPath, entry.name);
		for (const [, path] of (await readFile(file, "utf8")).matchAll(STYLE_IMPORT)) {
			const target = join(entry.parentPath, path!);
			await copyFile(join(P3, relative(dist, target)), target);
		}
	}
}

/** The esbuild options of one process's bundle in `dist`. */
export function bundleOptions(dist: string) {
	return {
		absWorkingDir: P3,
		outdir: dist,
		bundle: true,
		// Within one process's build only: what an entry imports lazily (`import()`) stays a chunk of its own, loaded
		// when it is asked for, not at the process's start.
		splitting: true,
		chunkNames: "chunks/[name]-[hash]",
		format: "esm",
		platform: "node",
		target: "node26",
		// Workspace packages resolve to their sources, as in development.
		conditions: ["source"],
		// No path alias of the monorepo applies: imports resolve as an installed package's would.
		tsconfigRaw: { compilerOptions: {} },
		external: [...EXTERNAL, ...OPTIONAL],
		// `ws` is CommonJS: its `require` of Node's builtins needs one in an ES module.
		banner: {
			js: 'import { createRequire as __p3CreateRequire } from "node:module"; const require = __p3CreateRequire(import.meta.url);',
		},
		minifySyntax: true,
		minifyWhitespace: true,
		legalComments: "none",
		sourcemap: false,
		metafile: true,
		logLevel: "warning",
	} as const satisfies BuildOptions;
}

/**
 * The launcher, `dist/p3.js`. No static import: ES modules are linked before any of them runs, so on a Node too old
 * for p3 a builtin it lacks (`node:sqlite` before 22.13, `enableCompileCache` before 22.1) would fail the whole graph
 * before a check could speak. It loads everything with `import()`: first the minimum-Node check (`minimum-node.js`,
 * a bundle of no imports), then Node's compile cache, so the bundle is compiled once and read from the cache
 * afterwards. Node's warning that `node:sqlite` is experimental is not for p3's users: experimental warnings are
 * dropped where they are emitted, and every other warning goes Node's own way (its printer, `--no-warnings`,
 * `--redirect-warnings`, the listeners others added). The source path passes `--disable-warning=ExperimentalWarning`
 * instead; a command's `#!` line takes no flags portably.
 */
const LAUNCHER = `#!/usr/bin/env node
await import("./minimum-node.js");
const { enableCompileCache } = await import("node:module");
enableCompileCache();
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
	const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
	if ((typeof warning === "string" ? type : warning?.name) === "ExperimentalWarning") return;
	return emitWarning.call(this, warning, ...rest);
};
await import("./main.js");
`;

/** What the build reads of p3's `package.json`. */
export type Manifest = { readonly version: string; readonly dependencies: Readonly<Record<string, string>> };

/**
 * Fails unless each dependency that is a workspace package (`versions`, by name) is pinned to the version the
 * workspace has: the bundle inlines the workspace's sources (Chord, Durable), the package's types come from the
 * dependency, and the two must be one version. Other dependencies (React, Elanor) come from the registry as pinned.
 */
export function checkVersions(manifest: Manifest, versions: Readonly<Record<string, string>>): void {
	for (const [name, pinned] of Object.entries(manifest.dependencies)) {
		if (Object.hasOwn(versions, name) && versions[name] !== pinned) {
			throw new Error(`build-release: ${name} is pinned to ${pinned}, the workspace has ${versions[name]}`);
		}
	}
}

/** A workspace package: its name, version, directory and dependencies. */
export type WorkspacePackage = {
	readonly name: string;
	readonly version: string;
	readonly directory: string;
	readonly dependencies: Readonly<Record<string, string>>;
	readonly scripts: Readonly<Record<string, string>>;
};

/**
 * The workspace package `name`, or `undefined` when it is not one: npm links a workspace package into the root's
 * `node_modules`, so its real path lies outside every `node_modules`.
 */
export async function workspacePackage(name: string): Promise<WorkspacePackage | undefined> {
	const directory = await realpath(join(REPOSITORY, "node_modules", name)).catch(() => undefined);
	if (directory === undefined || relative(REPOSITORY, directory).split(sep).includes("node_modules")) return undefined;
	const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as Partial<WorkspacePackage>;
	return {
		name,
		version: manifest.version ?? "",
		directory,
		dependencies: manifest.dependencies ?? {},
		scripts: manifest.scripts ?? {},
	};
}

/** The versions of those of `names` that are workspace packages. */
async function workspaceVersions(names: readonly string[]): Promise<Record<string, string>> {
	const versions: Record<string, string> = {};
	for (const name of names) {
		const found = await workspacePackage(name);
		if (found !== undefined) versions[name] = found.version;
	}
	return versions;
}

/** Fails when the bundle left an import to `node_modules` that is not allowed: it would be missing in an install. */
export function checkExternals(metafile: Pick<Metafile, "inputs">): void {
	const imports = Object.values(metafile.inputs).flatMap((input) => input.imports);
	const allowed = (path: string) => isBuiltin(path) || EXTERNAL.includes(path) || OPTIONAL.includes(path);
	const left = imports.filter(({ external, path }) => external === true && !allowed(path));
	if (left.length > 0) {
		const names = [...new Set(left.map(({ path }) => path))].sort().join(", ");
		throw new Error(`build-release: the bundle left unexpected external imports: ${names}`);
	}
}

/**
 * Fails unless the module `input` is in the output `output` of `dist/` and in no other: `src/install.ts` finds p3's
 * files relative to its own file, so it must stay in `dist/main.js`, not move to a chunk or another bundle.
 */
export function checkPlacement(metafile: Pick<Metafile, "outputs">, input: string, output: string): void {
	const found = Object.entries(metafile.outputs).filter(([, { inputs }]) => Object.hasOwn(inputs, input));
	if (found.length !== 1 || !found[0]![0].endsWith(`/${output}`)) {
		const where = found.map(([path]) => path).join(", ") || "no output";
		throw new Error(`build-release: ${input} must be bundled into ${output}, found in ${where}`);
	}
}

/** What a worker's or the supervisor's bundle must not import anywhere: the server's packages. */
const SERVER_IMPORTS = ["esbuild"];

/** What their start must not load (a chunk loaded lazily may: a provider SDK's HTTP client, on its first request). */
const EAGER_IMPORTS = ["http", "https", "node:http", "node:https"];

/** The modules of the server's that a worker's or the supervisor's bundle must not hold anywhere. */
const SERVER_INPUTS = [
	/\/node_modules\/esbuild\//,
	/\/chord\/src\/node\/(http\/http|http\/upgrades|workers\/workers|workers\/base|plugins\/build)\.ts$/,
];

/** What their start must not hold (a chunk loaded lazily may: `ws` in a provider SDK's chunk). */
const EAGER_INPUTS = [/\/node_modules\/ws\//];

/**
 * Fails when the build of `output` (`worker.js`, `supervisor.js`) imports or holds the server's code anywhere, the
 * chunks it loads lazily included (esbuild's JS API, Chord's HTTP component, the server side of its workers or its
 * plugin builds), or loads at its start (the entry and the chunks it imports statically) Node's HTTP or `ws`: every
 * session worker would load them for nothing. A chunk loaded lazily may hold them (a provider SDK's, loaded on the
 * first request to its provider).
 */
export function checkLean(metafile: Pick<Metafile, "outputs">, output: string): void {
	const entry = Object.keys(metafile.outputs).find((path) => path.endsWith(`/${output}`));
	if (entry === undefined) throw new Error(`build-release: no output ${output}`);
	const eager = eagerOutputs(metafile, entry);
	const server = Object.entries(metafile.outputs).flatMap(([path, found]) => {
		const imports = eager.has(path) ? [...SERVER_IMPORTS, ...EAGER_IMPORTS] : SERVER_IMPORTS;
		const inputs = eager.has(path) ? [...SERVER_INPUTS, ...EAGER_INPUTS] : SERVER_INPUTS;
		return [
			...found.imports
				.filter(({ path: imported }) => imports.includes(imported))
				.map(({ path: imported }) => imported),
			...Object.keys(found.inputs).filter((input) => inputs.some((pattern) => pattern.test(input))),
		];
	});
	if (server.length > 0) {
		throw new Error(`build-release: ${output} holds the server's ${[...new Set(server)].sort().join(", ")}`);
	}
}

/** The outputs a start of `entry` loads: it and every chunk reached through static imports. */
function eagerOutputs(metafile: Pick<Metafile, "outputs">, entry: string): ReadonlySet<string> {
	const eager = new Set([entry]);
	const queue = [entry];
	for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
		for (const { path: imported, kind } of metafile.outputs[path]!.imports) {
			if (kind !== "import-statement" || !Object.hasOwn(metafile.outputs, imported) || eager.has(imported)) continue;
			eager.add(imported);
			queue.push(imported);
		}
	}
	return eager;
}

if (import.meta.main) {
	const built = await buildRelease();
	console.log(`Built ${built.dist}: ${built.files.length} files, ${(built.bytes / 1024).toFixed(0)} KiB of bundles`);
}
