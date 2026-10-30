// Plugins (slice 7c): plugin directories turned into facets, loaded on their hosts, watched, rebuilt and rolled out.
// A plugin is a directory with a `package.json` (its name) and one file per facet kind (`server.ts`, `worker.ts`);
// `createPlugins` discovers them, builds each facet into a script with esbuild (host packages external) and evaluates
// it on Node. Here (`plugins/`): a contracts-only plugin, `@example/notes` with a server and a worker facet showing one
// label, and `@example/clock`, which the example never edits. A server and a worker load them; the notes' label is
// edited on disk, the watcher marks the plugin, the app builds it and rolls it out (server, then worker), a holder sees
// one frame, and the clock plugin is untouched (not in the reports, its object the same).
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/35-plugins/main.ts
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "../../../../src/context/index.ts";
import { createHost, type Host } from "../../../../src/next/host/index.ts";
import * as chordNext from "../../../../src/next/index.ts";
import { memoryLinkPair } from "../../../../src/next/link/index.ts";
import { createPlugins } from "../../../../src/next-node/plugins/index.ts";
import { Clock, Index, Notes, Worker } from "./plugins/contracts/contract.ts";

const context = BACKGROUND_CONTEXT;

// The example edits files: it works on a copy of `plugins/`, removed at the end.
const root = await mkdtemp(join(tmpdir(), "chord-example-35-"));
await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });

/** Waits until `ready()` holds (the watcher's events arrive on their own time). */
async function until(ready: () => boolean): Promise<void> {
	while (!ready()) await new Promise((resolve) => setTimeout(resolve, 10));
}

// 1. The component: the roots, the facet kinds, and the host packages every script gets (this process's Chord: a
//    plugin's `import { defineFacet } from "@earendil-works/chord/next"` is the app's own instance).
const plugins = createPlugins(
	{
		roots: [root],
		kinds: ["server", "worker"],
		hostPackages: { "@earendil-works/chord/next": chordNext },
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);

// 2. A worker and a server joined by a memory link; each loads the plugins' facets of its kind (no core facets here).
type P = { readonly kind: "server" } | { readonly kind: "worker" };
const [up, down] = memoryLinkPair();
const worker = createHost<P>({ address: Worker(), principal: { kind: "worker" }, onError: () => {} });
worker.connect(up, { principal: { kind: "server" } }, context);
const server = createHost<P>({ principal: { kind: "server" }, onError: () => {} });
server.route(
	Worker,
	{ authorize: () => true, resolve: async () => ({ link: down, principal: { kind: "worker" } }) },
	context,
);
const workerLoad = await plugins.load(worker, { kind: "worker", core: [] }, context);
const serverLoad = await plugins.load(server, { kind: "server", core: [] }, context);
console.log(
	"1. discovered:",
	plugins.discovery.plugins.map(({ name, facets }) => `${name} [${Object.keys(facets)}]`).join(", "),
);
console.log("   load failures: worker", workerLoad.failed.length, "| server", serverLoad.failed.length);
const notes = await server.get(Notes, {}, context);
const index = await server.get(Index, {}, context);
const clock = await server.get(Clock, {}, context);
await notes.add(context);
const evaluatedAt = clock.evaluatedAt.value;
console.log("   notes:", notes.label.value, "count", notes.count.value, "| index:", index.label.value);
const watch = await notes.label.watch(context);
watch.start(async (call) => {
	if (call.kind === "value") console.log("   a frame on the server's reference:", JSON.stringify(call.value));
});

// 3. An edit on disk (the app's editor, a git pull): the watcher marks the plugin dirty; nothing is applied yet.
await writeFile(join(root, "notes", "label.ts"), 'export const label = "v2";\n');
await until(() => plugins.state.value.dirty.includes("@example/notes"));
console.log("2. marks after the edit:", JSON.stringify(plugins.state.value));

// 4. The app builds the dirty plugins and rolls the build out: the server first, then the worker. Each step reloads its
//    host with the facets of its kind; the clock plugin was not built, so it keeps its facet and its object.
const steps = [plugins.step("server", server as Host<P>), plugins.step("worker", worker as Host<P>)];
const built = await plugins.build(plugins.state.value.dirty, context);
console.log(
	"3. built:",
	built.facets.map(({ plugin, facet, kind }) => `${plugin}/${facet}: ${kind}`),
);
const rolled = await plugins.rollout(steps, built, context);
for (const { name, report } of rolled.steps) {
	console.log(`   ${name}:`, JSON.stringify(report.plugins), "objects", JSON.stringify(report.objects));
}
await until(() => notes.label.value === "v2");
console.log("4. notes:", notes.label.value, "count", notes.count.value, "| index:", index.label.value);
console.log("   clock untouched:", clock.evaluatedAt.value === evaluatedAt);
console.log("   marks after the rollout:", JSON.stringify(plugins.state.value));

await watch.stop();
await server.close(context);
await worker.close(context);
plugins.close();
await rm(root, { recursive: true, force: true });
