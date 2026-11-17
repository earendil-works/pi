// Builds what p3 ships besides its sources (`docs/slices/26-release.md`), into `dist/`: the base code bundled, one
// bundle per process (`main.js`, the command and the server; `worker.js`, a session worker; `supervisor.js`; the kit,
// Chord and `ws` inlined where used, so no process loads TypeScript, and a worker or the supervisor none of the
// server's code), the launcher `p3.js`, and the API modules compiled one by one with their declarations
// (`api/v1/`, and what they import of the kit), which import Chord from the package's dependency: what a plugin's type
// check and editor resolve. `package.json` names the rest that ships (`files`).
// Run: npm run build (in apps/p3)

import { execFileSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type BuildOptions, build, type Metafile } from "esbuild";

/** p3's directory in the checkout. */
export const P3 = fileURLToPath(new URL("../", import.meta.url));

/** The repository's root: where esbuild, TypeScript and the workspace packages resolve from. */
export const REPOSITORY = join(P3, "..", "..");

/** The package the bundle leaves to `node_modules`: esbuild runs a binary of its own. */
const EXTERNAL = ["esbuild"];

/** Imports that may stay unresolved: `ws`'s optional native accelerators, which it does without when absent. */
const OPTIONAL = ["bufferutil", "utf-8-validate"];

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
		bundle("main", "bin.ts"),
		bundle("worker", "worker.ts"),
		bundle("supervisor", "supervisor.ts"),
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
		target: "node24",
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
 * Fails unless each dependency is pinned to the version the workspace has (`versions`): the bundle inlines the
 * workspace's Chord, the package's types come from the dependency, and the two must be one version.
 */
export function checkVersions(manifest: Manifest, versions: Readonly<Record<string, string>>): void {
	for (const [name, pinned] of Object.entries(manifest.dependencies)) {
		if (versions[name] !== pinned) {
			throw new Error(`build-release: ${name} is pinned to ${pinned}, the workspace has ${versions[name]}`);
		}
	}
}

/** The versions of the packages `names` as the repository's `node_modules` resolves them. */
async function workspaceVersions(names: readonly string[]): Promise<Record<string, string>> {
	const versions: Record<string, string> = {};
	for (const name of names) {
		const path = join(REPOSITORY, "node_modules", name, "package.json");
		versions[name] = (JSON.parse(await readFile(path, "utf8")) as { version: string }).version;
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

/** What a worker's or the supervisor's bundle must not import: the server's packages, and Node's HTTP. */
const SERVER_IMPORTS = ["esbuild", "http", "https", "node:http", "node:https"];

/** The modules of the server's that a worker's or the supervisor's bundle must not hold. */
const SERVER_INPUTS = [
	/\/node_modules\/(ws|esbuild)\//,
	/\/chord\/src\/node\/(http\/http|http\/upgrades|workers\/workers|workers\/base|plugins\/build)\.ts$/,
];

/**
 * Fails when the build of `output` (`worker.js`, `supervisor.js`), the entry or a chunk it loads lazily, imports or
 * holds the server's code: esbuild's JS API, `ws`, Node's HTTP, Chord's HTTP component, the server side of its workers
 * or its plugin builds. Every session worker would load it for nothing.
 */
export function checkLean(metafile: Pick<Metafile, "outputs">, output: string): void {
	if (!Object.keys(metafile.outputs).some((path) => path.endsWith(`/${output}`))) {
		throw new Error(`build-release: no output ${output}`);
	}
	const server = Object.values(metafile.outputs).flatMap((found) => [
		...found.imports.filter(({ path }) => SERVER_IMPORTS.includes(path)).map(({ path }) => path),
		...Object.keys(found.inputs).filter((input) => SERVER_INPUTS.some((pattern) => pattern.test(input))),
	]);
	if (server.length > 0) {
		throw new Error(`build-release: ${output} holds the server's ${[...new Set(server)].sort().join(", ")}`);
	}
}

if (import.meta.main) {
	const built = await buildRelease();
	console.log(`Built ${built.dist}: ${built.files.length} files, ${(built.bytes / 1024).toFixed(0)} KiB of bundles`);
}
