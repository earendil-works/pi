// The session worker's base (Chord's worker base of src/hosts/worker.ts): a fork loads no provider SDK and no esbuild
// (pi-ai's provider APIs stay lazy chunks), and the OAuth flows and Bedrock, which pi-ai imports through variable
// specifiers by default, are lazy chunks of the snapshot (worker-oauth.test.ts runs them).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildWorkerBase, type WorkerBase } from "../../../../packages/chord/src/node/workers/base.ts";

const WORKER = fileURLToPath(new URL("../../src/hosts/worker.ts", import.meta.url));
const AI_SOURCE = fileURLToPath(new URL("../../../../packages/ai/src/", import.meta.url));
// As the server forks session workers (src/hosts/server.ts).
const EXEC_ARGV = ["--max-semi-space-size=2", "--import", new URL("../../src/source.ts", import.meta.url).href];

/** Installed packages a fork must not load before a request needs them. */
const LAZY_PACKAGES = ["@anthropic-ai/sdk", "openai", "@google/genai", "@mistralai/", "@aws-sdk/", "esbuild"];

let base: WorkerBase;

before(async () => {
	base = await buildWorkerBase(WORKER, EXEC_ARGV);
});

after(() => base.remove());

test("a fork's static graph has no provider SDK and no esbuild", () => {
	const { externals } = staticGraph(base.file());
	assert.ok(externals.length > 0);
	const loaded = externals.filter((specifier) =>
		LAZY_PACKAGES.some((name) => specifier.includes(`/node_modules/${name}`)),
	);
	assert.deepEqual(loaded, []);
});

test("the OAuth flows and Bedrock are lazy chunks of the snapshot", () => {
	const { chunks } = staticGraph(base.file());
	for (const source of ["auth/oauth/radius.ts", "auth/oauth/anthropic.ts", "api/bedrock-converse-stream.ts"]) {
		const holders = chunksWith(join(AI_SOURCE, source));
		assert.equal(holders.length, 1, source);
		assert.ok(!chunks.includes(holders[0]!), `${source} is imported statically`);
	}
});

/** The chunks (file names) the entry imports statically, transitively, and the external modules they import. */
function staticGraph(entry: string): { chunks: string[]; externals: string[] } {
	const dir = dirname(entry);
	const chunks: string[] = [];
	const externals = new Set<string>();
	const visit = (name: string): void => {
		if (chunks.includes(name)) return;
		chunks.push(name);
		const code = readFileSync(join(dir, name), "utf8");
		for (const [, specifier] of code.matchAll(/^(?:import|export)\s(?:[^;"]*?\sfrom\s*)?"([^"]+)"/gm)) {
			if (specifier!.startsWith("./")) visit(specifier!.slice(2));
			else externals.add(specifier!);
		}
	};
	visit(parse(entry).base);
	return { chunks, externals: [...externals] };
}

/** The bundle's modules that hold the module `source`: their source maps (`<name>.map` beside them) name it. */
function chunksWith(source: string): string[] {
	const dir = dirname(base.file());
	return readdirSync(dir)
		.filter((name) => name.endsWith(".mjs"))
		.filter((name) => {
			const { sources, sourceRoot } = JSON.parse(readFileSync(join(dir, `${name}.map`), "utf8")) as SourceMap;
			return sources.some((path) => fileURLToPath(new URL(path, sourceRoot)) === source);
		});
}

type SourceMap = { readonly sources: readonly string[]; readonly sourceRoot: string };
