// The pages' base bundle builds from sources, as the server process runs them: none of its files comes from a workspace
// package's `dist/`, which a checkout that never builds them (the phone) lacks. A package whose `exports` name only
// `dist/` (pi-ai's `./utils/*`) broke the base there while CI, with `dist/`, passed. (Plugins' web scripts read no
// workspace package: the app's packages are host packages to them.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildBase, WEB_PREFIX } from "@earendil-works/chord/surfaces";
import { WEB_ENTRY, WEB_RESOLUTION } from "../../src/hosts/web/base.ts";

const REPOSITORY = fileURLToPath(new URL("../../../../", import.meta.url));

/** The files of `paths` under a workspace package's `dist/`, relative to the repository. */
const fromDist = (paths: Iterable<string>): string[] =>
	[...paths].map((path) => relative(REPOSITORY, path)).filter((path) => /^packages\/[^/]+\/dist\//.test(path));

/** `@earendil-works/*` paths of the tsconfig.json at `file`, as absolute paths (comments in it allowed). */
function workspacePaths(file: string): Record<string, string[]> {
	const text = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "");
	const paths = (JSON.parse(text) as { compilerOptions: { paths: Record<string, string[]> } }).compilerOptions.paths;
	return Object.fromEntries(
		Object.entries(paths)
			.filter(([pattern]) => pattern.startsWith("@earendil-works/"))
			.map(([pattern, targets]) => [pattern, targets.map((target) => resolve(dirname(file), target))]),
	);
}

describe("the pages' code from sources", () => {
	it("resolves workspace packages as the server's source resolver does: the same paths", () => {
		// src/source-resolver.ts maps `@earendil-works/*` through the repository's tsconfig; the base through p2's.
		assert.deepEqual(workspacePaths(WEB_RESOLUTION.tsconfig), workspacePaths(resolve(REPOSITORY, "tsconfig.json")));
	});

	it("builds the base bundle without a package's dist/", async () => {
		const base = await buildBase(WEB_ENTRY, "browser", WEB_PREFIX, WEB_RESOLUTION);
		assert.deepEqual(fromDist(base.inputs.keys()), []);
	});
});
