// Installing (slice 7c §5, decision "Slice 7c's points" (3); slice 12 §5, decision "`chord.plugins` is a package's
// manifest of plugins"): a plugin's npm dependencies as coding-agent installs a package's (`npm install` in the
// plugin's real directory without dev dependencies, host peers or lifecycle scripts; the command overridable), and new
// plugins from git (a shallow clone of a ref) or npm (a packed tarball extracted), each staged in a hidden directory of
// the root, checked as discovery sees it, then renamed into place. Nothing a source supplies reaches git or npm as an
// option: refs, URLs and names starting with `-` are refused, and positional arguments follow `--`.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Context } from "../../context/index.ts";
import { isPluginName } from "../../next/host/staging.ts";
import { discoverPackage, discoverPlugins, type Plugin, type PluginRoot } from "./discover.ts";

/** What installs take: the npm command (`["npm"]` by default, e.g. `["pnpm"]`); git and tar are run as `git`, `tar`. */
export type InstallOptions = { readonly npmCommand?: readonly string[] };

/** What `installPlugin` takes besides the source and the root. */
export type InstallPluginOptions = InstallOptions & {
	/** The app's facet kinds: a package whose top has a facet file is one plugin (`[]` by default). */
	readonly kinds?: readonly string[];
	/** Every root of the app: a new plugin named like one in any of them is refused (`[root]` by default). */
	readonly roots?: readonly PluginRoot[];
};

/** Where `installPlugin` installs from: a git repository at a ref (a branch, tag or commit), or an npm package. */
export type PluginSource =
	| { readonly git: string; readonly ref: string }
	| { readonly npm: string; readonly version: string };

/** The install's arguments: production dependencies only, no host peers, no scripts, no audit or funding notes. */
const INSTALL_ARGS = ["install", "--omit=dev", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund"];

/**
 * Installs `plugin`'s `dependencies` into its own `node_modules` (`npm install --omit=dev --legacy-peer-deps
 * --ignore-scripts --no-audit --no-fund` in its real directory; git dependencies with a ref are npm's). Rejects with
 * the command's output when it fails, and when `context` aborts (the command is killed). A single-file plugin has
 * nothing to install.
 */
export async function installDependencies(
	plugin: Plugin,
	context: Context,
	options: InstallOptions = {},
): Promise<void> {
	if (plugin.layout === "file") throw new Error(`plugin "${plugin.name}": a single-file plugin has no package.json`);
	const [command, ...prefix] = npmCommandOf(options);
	await run(command, [...prefix, ...INSTALL_ARGS], plugin.dir, context, `plugin "${plugin.name}": ${command} install`);
}

/**
 * Installs new plugins into `root` from `source`, then their dependencies: from git, a shallow clone of the ref into
 * `<root>/<repository name>`; from npm, the packed package extracted into `<root>/<name>`. The package's plugins are
 * its `chord.plugins` folders, else by convention (discovery's rules). Returns their names. Refused: a source option
 * (`-…`), an invalid name, an existing directory (no updating in place: install another ref, or delete and install), a
 * package discovery reports a problem in or finds no plugin in, a plugin name another plugin of `options.roots` has.
 * Only what this install created is removed on failure.
 */
export async function installPlugin(
	source: PluginSource,
	root: string,
	context: Context,
	options: InstallPluginOptions = {},
): Promise<readonly string[]> {
	const name = targetName(source);
	await removeStaleStaging(root);
	const made = await claim(root, name);
	let staging: string | undefined;
	try {
		// Hidden: discovery skips it while it is staged; in the root: the rename stays on one file system.
		staging = await mkdtemp(join(root, STAGING));
		const staged = join(staging, "package");
		if ("git" in source) await clone(source.git, source.ref, staged, context);
		else await unpack(source.npm, source.version, staged, context, options);
		await checkPackage(staged, made.target, root, context, options);
		// The claimed directory is empty: renaming onto it moves the package into place in one step. Windows renames onto
		// no existing directory: there the claim is released first (a concurrent install of the name may then win).
		if (process.platform === "win32") await rmdir(made.target);
		await rename(staged, made.target);
		const { plugins } = await discoverPackage(made.target, atRoot(root, options), context);
		for (const plugin of plugins) await installDependencies(plugin, context, options);
		return plugins.map((plugin) => plugin.name);
	} catch (error) {
		await rm(made.target, { recursive: true, force: true });
		if (made.scope !== undefined) await rmdir(made.scope).catch(() => {});
		throw error;
	} finally {
		if (staging !== undefined) await rm(staging, { recursive: true, force: true });
	}
}

/** The prefix of an install's staging directory in a root (hidden: discovery skips it). */
const STAGING = ".chord-install-";

/** How old a staging directory must be to count as left over by a crashed install. */
const STALE_MS = 60 * 60 * 1000;

/** Removes staging directories in `root` an install crashed out of (older than an hour). */
async function removeStaleStaging(root: string): Promise<void> {
	const names = await readdir(root).catch(() => [] as string[]);
	for (const name of names.filter((each) => each.startsWith(STAGING))) {
		const path = join(root, name);
		const info = await stat(path).catch(() => undefined);
		if (info !== undefined && Date.now() - info.mtimeMs > STALE_MS) await rm(path, { recursive: true, force: true });
	}
}

/** The directory name a source installs into: the repository's name, or the package's (validated) name. */
function targetName(source: PluginSource): string {
	const option = (value: string, what: string) => {
		if (value === "" || value.startsWith("-")) throw new Error(`installPlugin: ${what} "${value}" is refused`);
	};
	if ("git" in source) {
		option(source.git, "repository");
		option(source.ref, "ref");
		const name = basename(source.git.replace(/\/+$/, "")).replace(/\.git$/, "");
		if (name === "" || name.startsWith(".") || name.startsWith("-")) {
			throw new Error(`installPlugin: "${source.git}" names no repository directory`);
		}
		return name;
	}
	option(source.npm, "package");
	option(source.version, "version");
	if (!isPluginName(source.npm)) throw new Error(`installPlugin: "${source.npm}" is not an npm package name`);
	return source.npm;
}

/**
 * Creates `<root>/<name>` (and a scope directory `<root>/@scope` it needs) without `recursive`, so an existing one
 * refuses the install and a concurrent install of the same name loses here; returns what it created.
 */
async function claim(root: string, name: string): Promise<{ readonly target: string; readonly scope?: string }> {
	const target = join(root, name);
	let scope: string | undefined;
	if (name.startsWith("@")) {
		const dir = dirname(target);
		try {
			await mkdir(dir);
			scope = dir;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	try {
		await mkdir(target);
	} catch (error) {
		if (scope !== undefined) await rmdir(scope).catch(() => {});
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`installPlugin: ${target} exists already`);
		}
		throw error;
	}
	return scope === undefined ? { target } : { target, scope };
}

/** The root a package is discovered as part of. */
function atRoot(root: string, options: InstallPluginOptions) {
	return { root, required: false, kinds: options.kinds ?? [] };
}

/**
 * Checks the package staged at `staged` (going to `target`): discovery reports no problem in it, finds a plugin, and
 * none of its plugins' names is taken in the app's roots.
 */
async function checkPackage(
	staged: string,
	target: string,
	root: string,
	context: Context,
	options: InstallPluginOptions,
): Promise<void> {
	const { plugins, problems } = await discoverPackage(staged, atRoot(root, options), context);
	const [problem] = problems;
	if (problem !== undefined)
		throw new Error(`installPlugin: ${problem.path.replace(staged, target)}: ${problem.error}`);
	if (plugins.length === 0) throw new Error(`installPlugin: ${target} holds no plugin`);
	const installed = await discoverPlugins(options.roots ?? [root], { kinds: options.kinds ?? [] }, context);
	for (const plugin of plugins) {
		const other = installed.plugins.find((each) => each.name === plugin.name);
		if (other !== undefined) throw new Error(`installPlugin: plugin "${plugin.name}" is in ${other.dir} already`);
	}
}

/** The npm command of `options`. */
function npmCommandOf(options: InstallOptions): readonly [string, ...string[]] {
	const [command, ...prefix] = options.npmCommand ?? ["npm"];
	if (command === undefined) throw new Error("npmCommand is empty");
	return [command, ...prefix];
}

/** Runs `command` in `cwd`; rejects naming `what` with its output when it fails, and when `context` aborts. */
async function run(
	command: string,
	args: readonly string[],
	cwd: string,
	context: Context,
	what: string,
): Promise<string> {
	context.abortSignal?.throwIfAborted();
	const child = spawn(command, args, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		signal: context.abortSignal,
		// Never a prompt for credentials: an install runs unattended.
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	let output = "";
	let stdout = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	if (code !== 0) throw new Error(`${what} failed (exit ${code}): ${output.trim()}`);
	return stdout;
}

/** A shallow clone of `ref` (a branch, tag or commit) of `url` into `dir` (made), detached at it. */
async function clone(url: string, ref: string, dir: string, context: Context): Promise<void> {
	await mkdir(dir);
	const what = `git clone of ${url} at ${ref}`;
	await run("git", ["init", "--quiet"], dir, context, what);
	await run("git", ["fetch", "--quiet", "--depth", "1", "--", url, ref], dir, context, what);
	await run("git", ["-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD", "--"], dir, context, what);
}

/** npm package `name` at `version` packed (`npm pack`) and extracted into `dir` (made). */
async function unpack(
	name: string,
	version: string,
	dir: string,
	context: Context,
	options: InstallOptions,
): Promise<void> {
	const [command, ...prefix] = npmCommandOf(options);
	const packed = await mkdtemp(join(dirname(dir), "pack-"));
	const what = `${command} pack ${name}@${version}`;
	const args = [...prefix, "pack", "--json", "--pack-destination", packed, "--", `${name}@${version}`];
	// npm's own output: a list of the packed tarballs.
	const [tarball] = JSON.parse(await run(command, args, packed, context, what)) as { readonly filename: string }[];
	if (tarball === undefined) throw new Error(`${what}: packed nothing`);
	await mkdir(dir);
	const file = join(packed, basename(tarball.filename));
	await run("tar", ["-xzf", file, "--strip-components=1", "-C", dir], packed, context, `extracting ${name}`);
}
