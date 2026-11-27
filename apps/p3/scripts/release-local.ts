// A local release of p3 (`docs/slices/26-release.md`): builds p3 and the workspace packages it depends on, directly or
// through another of them (Chord, pi-ai, Durable, pi-codemode, pi-schema, pi-telemetry: their published versions do
// not have what p3 uses yet), packs them and installs p3's tarball, the others as overrides, into a directory outside
// the repository, as a user installing from npm would (no lifecycle script of a dependency runs), so nothing there
// resolves a workspace source. Its other dependencies (React, Elanor, esbuild, ws) come from the registry as p3 pins
// them. pi-env's package ships this system's terminal daemon (its `bin/`): a published one gets every system's from CI
// (`.github/workflows/env-daemons.yml`), a local release the checkout's build. Then the release test runs against the
// install, and with `--bench` the bench.
// Run from the repository root: npm run release:p3:local -- --out /tmp/p3-release [--force] [--skip-test] [--bench]

import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { terminalDaemon } from "../src/api/v1/terminal-daemon.ts";
import { buildRelease, P3, REPOSITORY, type WorkspacePackage, workspacePackage } from "./build-release.ts";

const USAGE = `Usage: npm run release:p3:local -- --out <dir> [--force] [--skip-test] [--bench]

  --out <dir>   Where the release goes, outside the repository: tarballs/, install/ (an isolated npm install of
                p3's tarball) and p3 (a link to the installed command)
  --force       Replace the release a previous run left in <dir>
  --skip-test   Do not run the release test against the install
  --bench       Run bench/skeleton.ts and bench/base.ts against the install afterwards`;

/** The file that marks a directory as a release this script made: only such a directory is ever emptied. */
const MARKER = ".p3-release";

/** What the script makes in its output directory, and so what `--force` removes there: nothing else. */
const MADE = [MARKER, "tarballs", "install", "p3"];

/**
 * The workspace packages p3's `dependencies` name, directly or through another workspace package, each after the
 * workspace packages it depends on (the order they build in).
 */
export async function workspaceDependencies(
	dependencies: Readonly<Record<string, string>>,
): Promise<WorkspacePackage[]> {
	const ordered: WorkspacePackage[] = [];
	const seen = new Set<string>();
	const visit = async (name: string): Promise<void> => {
		if (seen.has(name)) return;
		seen.add(name);
		const found = await workspacePackage(name);
		if (found === undefined) return;
		for (const dependency of Object.keys(found.dependencies)) await visit(dependency);
		ordered.push(found);
	};
	for (const name of Object.keys(dependencies)) await visit(name);
	return ordered;
}

/**
 * Builds the workspace package `found` for packing: `build:offline` when it has one (pi-ai's `build` first regenerates
 * its model catalog from the network, which a release of p3 must not change), else `build`.
 */
function buildPackage(found: WorkspacePackage): void {
	const script = Object.hasOwn(found.scripts, "build:offline") ? "build:offline" : "build";
	execFileSync("npm", ["run", script], { cwd: found.directory, stdio: "inherit" });
}

/** The package whose `bin/` ships the terminal daemon. */
const PI_ENV = "@earendil-works/pi-env";

/**
 * Puts this system's terminal daemon into pi-env's `bin/` (gitignored: what its package ships): the checkout's build
 * (`npm run build:daemon`), which `terminalDaemon` finds first, replacing what an earlier release put there; without a
 * build, what is there already; without either the release fails, naming the command.
 */
async function shipDaemon(found: WorkspacePackage): Promise<void> {
	const shipped = join(found.directory, "bin", `pi-env-${process.platform}-${process.arch}`, "pi-env");
	const daemon = await terminalDaemon();
	if (daemon === shipped) return;
	await mkdir(dirname(shipped), { recursive: true });
	await copyFile(daemon, shipped);
	await chmod(shipped, 0o755);
}

/**
 * The output directory `out`, ready: made when missing, used when empty, and with `force` cleared of what a previous
 * run made there. Refused before anything is removed: the repository, a directory above it (a file system's root is
 * one) or inside it, by real paths, so not through a link either; and a directory with other content, which is not
 * ours to empty.
 */
export async function prepareOutput(out: string, force: boolean): Promise<string> {
	const path = await realOf(resolve(out));
	const repository = await realpath(REPOSITORY);
	if (within(repository, path) || within(path, repository)) {
		throw new Error(`release-local: ${path} must be outside the repository, and not above it`);
	}
	await mkdir(path, { recursive: true });
	const present = await readdir(path);
	if (present.length > 0) {
		if (!present.includes(MARKER)) {
			throw new Error(`release-local: ${path} holds something else than a release of this script; not touched`);
		}
		if (!force) throw new Error(`release-local: ${path} holds a release (pass --force to replace it)`);
		for (const name of MADE) await rm(join(path, name), { recursive: true, force: true });
	}
	await writeFile(join(path, MARKER), "A local release of p3, made by apps/p3/scripts/release-local.ts.\n");
	return path;
}

/** Whether `path` is `directory` or lies in it, by path segments. */
function within(path: string, directory: string): boolean {
	const from = relative(directory, path);
	return from === "" || !(from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from));
}

/** `path` with its existing part resolved through links: the part that does not exist yet is appended as it is. */
async function realOf(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return join(await realOf(dirname(path)), basename(path));
	}
}

/** Runs npm in `cwd` and answers what it printed; no lifecycle script of any package runs. */
function npm(args: readonly string[], cwd: string): string {
	return execFileSync("npm", [...args, "--ignore-scripts"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
}

/** Packs the package in `directory` into `tarballs`: its name and its tarball's path. */
function pack(directory: string, tarballs: string): { readonly name: string; readonly tarball: string } {
	const [packed] = JSON.parse(npm(["pack", "--json", "--pack-destination", tarballs], directory)) as [
		{ readonly name: string; readonly filename: string },
	];
	return { name: packed.name, tarball: join(tarballs, packed.filename) };
}

/** Runs a script of p3's checkout against the install `install`. */
function run(args: readonly string[], install: string): void {
	execFileSync(args[0]!, args.slice(1), { cwd: P3, stdio: "inherit", env: { ...process.env, P3_RELEASE: install } });
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			out: { type: "string" },
			force: { type: "boolean", default: false },
			"skip-test": { type: "boolean", default: false },
			bench: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help || values.out === undefined) {
		console.log(USAGE);
		process.exit(values.help ? 0 : 2);
	}
	const out = await prepareOutput(values.out, values.force);
	const manifest = JSON.parse(await readFile(join(P3, "package.json"), "utf8")) as {
		readonly dependencies: Readonly<Record<string, string>>;
	};
	const workspace = await workspaceDependencies(manifest.dependencies);
	for (const found of workspace) {
		buildPackage(found);
		if (found.name === PI_ENV) await shipDaemon(found);
	}
	const built = await buildRelease();
	console.log(`Built ${built.dist}: ${built.files.length} files, ${(built.bytes / 1024).toFixed(0)} KiB of bundles`);
	const tarballs = join(out, "tarballs");
	await mkdir(tarballs);
	const p3 = pack(P3, tarballs);
	const dependencies = workspace.map(({ directory }) => pack(directory, tarballs));
	// An isolated consumer: a private package whose one dependency is p3's tarball. Its dependencies of the workspace
	// come from their tarballs too, not from the registry.
	const install = join(out, "install");
	await mkdir(install);
	const consumer = {
		private: true,
		type: "module",
		dependencies: { [p3.name]: `file:${p3.tarball}` },
		overrides: Object.fromEntries(dependencies.map(({ name, tarball }) => [name, `file:${tarball}`])),
	};
	await writeFile(join(install, "package.json"), `${JSON.stringify(consumer, null, "\t")}\n`);
	npm(["install", "--omit=dev", "--no-audit", "--no-fund"], install);
	await symlink(join("install", "node_modules", ".bin", "p3"), join(out, "p3"));
	if (!values["skip-test"]) run(["npm", "run", "test:release"], install);
	if (values.bench) {
		const flags = ["--conditions=source", "--disable-warning=ExperimentalWarning"];
		for (const bench of ["bench/skeleton.ts", "bench/base.ts"])
			run([process.execPath, ...flags, bench, "--release", out], install);
	}
	console.log(
		`\nLocal release of ${p3.name}: ${out}\n  the command: ${join(out, "p3")}\n  the tarball: ${p3.tarball}`,
	);
}
