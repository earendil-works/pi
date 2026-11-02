// Test support for the plugins component (slice 7c, slice 12): fixture plugins copied into temporary roots, plugins, npm
// packages and local bare git repositories written there (no network), and the host packages the fixtures import.

import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import * as chordNext from "../../../src/next/index.ts";
import type { HostPackages, KindDefinition } from "../../../src/next-node/plugins/index.ts";

/** The fixture plugins' directory. */
export const FIXTURES = fileURLToPath(new URL("../fixtures/plugins/", import.meta.url));

/** The host packages the fixtures import: this process's Chord. */
export const HOST_PACKAGES: HostPackages = { "@earendil-works/chord/next": chordNext };

/** The facet kinds of the fixtures' app. */
export const KINDS = ["server", "worker", "web"] as const;

/** The fixtures' app's kinds as the component takes them: Node servers and workers, a browser web, `modules`' names. */
export function kindsOf(modules: HostPackages): Readonly<Record<string, KindDefinition>> {
	const hostPackages = Object.keys(modules);
	return {
		server: { platform: "node", hostPackages },
		worker: { platform: "node", hostPackages },
		web: { platform: "browser", hostPackages },
	};
}

const made: string[] = [];

afterEach(async () => {
	for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A temporary directory removed after the test; `fixtures` (names of fixture plugins) copied into it. */
export async function tempRoot(fixtures: readonly string[] = []): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "chord-plugins-"));
	made.push(root);
	for (const name of fixtures) await cp(join(FIXTURES, name), join(root, name), { recursive: true });
	return root;
}

/** Writes `files` (relative path to text) into `dir`, creating directories. */
export async function writeFiles(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), text);
	}
}

/** Writes a plugin named `name` into `root/dir`: its `package.json` (with `manifest`'s fields) and `files`. */
export async function writePlugin(
	root: string,
	dir: string,
	name: string,
	files: Readonly<Record<string, string>>,
	manifest: Readonly<Record<string, unknown>> = {},
): Promise<string> {
	const path = join(root, dir);
	await writeFiles(path, { "package.json": JSON.stringify({ name, type: "module", ...manifest }), ...files });
	return path;
}

/** Writes an npm package `name` into `dir`'s `node_modules`: its `package.json` (CommonJS unless `type`) and files. */
export async function writePackage(
	dir: string,
	name: string,
	files: Readonly<Record<string, string>>,
	manifest: Readonly<Record<string, unknown>> = {},
): Promise<void> {
	const main = Object.keys(files)[0]!;
	const json = JSON.stringify({ name, version: "1.0.0", main, ...manifest });
	await writeFiles(join(dir, "node_modules", name), { "package.json": json, ...files });
}

/**
 * A local bare git repository `<name>.git` in a temporary directory with `files` committed (one commit), tagged `tag`:
 * its `file://` URL and the commit. A call with `previous` adds another commit on top of that repository.
 */
export async function gitRepository(
	name: string,
	files: Readonly<Record<string, string>>,
	tag: string,
	previous?: { readonly work: string; readonly bare: string },
): Promise<{ readonly url: string; readonly commit: string; readonly work: string; readonly bare: string }> {
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], {
			cwd,
			encoding: "utf8",
		}).trim();
	const work = previous?.work ?? (await tempRoot());
	if (previous === undefined) git(work, "init", "--quiet");
	await writeFiles(work, files);
	git(work, "add", "--all");
	git(work, "commit", "--quiet", "--message", tag);
	git(work, "tag", tag);
	const bare = previous?.bare ?? join(await tempRoot(), `${name}.git`);
	if (previous === undefined) git(work, "clone", "--quiet", "--bare", work, bare);
	else git(work, "push", "--quiet", "--tags", bare, "HEAD:refs/heads/master");
	return { url: `file://${bare}`, commit: git(work, "rev-parse", "HEAD"), work, bare };
}
