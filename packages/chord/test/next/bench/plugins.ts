// Benchmark of the plugins component (slice 7c §7): a cold build of a 20-plugin set (one worker facet each, its own
// files, a copied contract), a rebuild of one facet after an edit, the evaluation of a facet (`vm.Script`), and the heap
// after 100 reloads of one plugin on a host (old facets collected, V8's compilation cache off). Medians over runs.
// Run by hand from packages/chord (not in CI), pinned for comparisons:
//   taskset -c 6 node --conditions=source --experimental-strip-types --expose-gc test/next/bench/plugins.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { createHost } from "../../../src/next/host/index.ts";
import * as chordNext from "../../../src/next/index.ts";
import {
	type BuiltScript,
	buildFacet,
	createPlugins,
	discoverPlugins,
	evaluateFacet,
} from "../../../src/next-node/plugins/index.ts";

const PLUGINS = 20;
const RUNS = 7;
const RELOADS = 100;

const gc = (globalThis as { gc?: () => void }).gc!;
const HOST_PACKAGES = { "@earendil-works/chord/next": chordNext };
const KINDS = ["server", "worker"];

/** A plugin's worker facet: a store over a document, a derive, a method, a helper module and the shared contract. */
function worker(index: number, label: string): string {
	return [
		'import { constant, defineFacet, defineState, int, local, method, obj, str } from "@earendil-works/chord/next";',
		'import { Shared } from "../contracts/contract.ts";',
		'import { format } from "./format.ts";',
		`const Store = local("bench.store${index}", { version: 1, params: {}, members: { label: str(), n: int(), bump: method(undefined, int()) } });`,
		'const Count = defineState("count", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });',
		"export default defineFacet((host) => host.serve(Store, (_, self) => {",
		"  const doc = self.state(Count);",
		`  return { label: constant(format(${JSON.stringify(label)}, Shared.name)), n: self.derive([doc], ([d]) => d.n),`,
		"    bump: async (ctx) => { await doc.change((d) => { d.n += 1; }, ctx); return doc.value.n; } };",
		"}));",
	].join("\n");
}

/** Writes the 20-plugin set (and the contracts plugin) under a new root. */
async function pluginSet(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "chord-bench-plugins-"));
	const write = async (dir: string, files: Record<string, string>) => {
		await mkdir(join(root, dir), { recursive: true });
		for (const [file, text] of Object.entries(files)) await writeFile(join(root, dir, file), text);
	};
	await write("contracts", {
		"package.json": JSON.stringify({ name: "@bench/contracts", type: "module" }),
		"contract.ts":
			'import { local, str } from "@earendil-works/chord/next";\nexport const Shared = local("bench.shared", { version: 1, params: {}, members: { name: str() } });',
	});
	for (let index = 0; index < PLUGINS; index++) {
		await write(`p${index}`, {
			"package.json": JSON.stringify({ name: `@bench/p${index}`, type: "module" }),
			"worker.ts": worker(index, "v1"),
			"format.ts":
				'export function format(label: string, name: string): string {\n  return label + " (" + name + ")";\n}',
		});
	}
	return root;
}

/** Median of `values`. */
function median(values: number[]): number {
	return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

const root = await pluginSet();
const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
const options = { hostPackages: Object.keys(HOST_PACKAGES), platform: "node", plugins } as const;
const facets = plugins.filter((plugin) => plugin.facets.worker !== undefined);

// A cold build of every worker facet (each its own esbuild build, all at once as the component runs them).
const cold: number[] = [];
let scripts: BuiltScript[] = [];
for (let run = 0; run < RUNS; run++) {
	const started = performance.now();
	const built = await Promise.all(facets.map((plugin) => buildFacet(plugin, "worker", options, context)));
	cold.push(performance.now() - started);
	scripts = built.filter((each): each is BuiltScript => each.kind === "script");
}
const bytes = scripts.reduce((sum, each) => sum + each.source.length, 0);
console.log(
	`cold build of ${facets.length} worker facets: ${median(cold).toFixed(1)} ms (median of ${RUNS}), ${(bytes / 1024).toFixed(1)} KiB of scripts`,
);

// A rebuild of one facet after an edit.
const rebuild: number[] = [];
for (let run = 0; run < RUNS; run++) {
	await writeFile(join(root, "p0", "worker.ts"), worker(0, `edit ${run}`));
	const started = performance.now();
	await buildFacet(facets[0]!, "worker", options, context);
	rebuild.push(performance.now() - started);
}
console.log(`rebuild of one facet: ${median(rebuild).toFixed(1)} ms (median of ${RUNS})`);

// The evaluation of a facet: compile and run its script.
const evaluations: number[] = [];
for (let run = 0; run < RUNS; run++) {
	const started = performance.now();
	for (let index = 0; index < scripts.length; index++) {
		evaluateFacet(scripts[index]!, { hostPackages: HOST_PACKAGES, plugin: facets[index]! });
	}
	evaluations.push((performance.now() - started) / scripts.length);
}
console.log(`evaluation per facet: ${median(evaluations).toFixed(2)} ms (median of ${RUNS})`);

// The heap after 100 reloads of one plugin on a host, against after a warm-up (two builds alternating).
const component = createPlugins(
	{ roots: [root], kinds: KINDS, hostPackages: HOST_PACKAGES, onError: () => {} },
	context,
);
const host = createHost({ onError: () => {} });
await component.load(host, { kind: "worker", core: [] }, context);
await writeFile(join(root, "p0", "worker.ts"), worker(0, "a"));
const first = await component.build(["@bench/p0"], context);
await writeFile(join(root, "p0", "worker.ts"), worker(0, "b"));
const second = await component.build(["@bench/p0"], context);
const settled = async (): Promise<number> => {
	for (let round = 0; round < 5; round++) {
		await new Promise((resolve) => setImmediate(resolve));
		gc();
	}
	return process.memoryUsage().heapUsed;
};
for (let reload = 0; reload < 10; reload++) await component.reload(host, reload % 2 === 0 ? second : first, context);
const warm = await settled();
const reloadTimes: number[] = [];
for (let reload = 0; reload < RELOADS; reload++) {
	const started = performance.now();
	await component.reload(host, reload % 2 === 0 ? second : first, context);
	reloadTimes.push(performance.now() - started);
}
const after = await settled();
console.log(
	`reload of one plugin (evaluation and host reload): ${median(reloadTimes).toFixed(2)} ms (median of ${RELOADS})`,
);
console.log(`heap after ${RELOADS} reloads: ${((after - warm) / 1024).toFixed(0)} KiB against after the warm-up`);
await host.close(context);
component.close();
await rm(root, { recursive: true, force: true });
