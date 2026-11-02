// A rollout across the server and its workers (slice 10): an edit of a plugin is built once by the server and rolled
// out step by step, the server first, then every running worker; each host reports what changed.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/43-rollout/main.ts
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "../../../../src/context/index.ts";
import { hostKind } from "../../../../src/next/contracts/index.ts";
import { createHost } from "../../../../src/next/host/index.ts";
import * as chordNext from "../../../../src/next/index.ts";
import { createPlugins, type RolloutHost } from "../../../../src/next-node/plugins/index.ts";
import { createWorkers } from "../../../../src/next-node/workers/index.ts";
import { Banner, Label, Session } from "./plugins/notes/contract.ts";

/** Waits until `done()` holds (a watcher's mark, a frame from a worker), checking every 10 ms. */
async function waitUntil(done: () => boolean): Promise<void> {
	while (!done()) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** One line for what a rollout step did on one of its hosts. */
function describe(host: RolloutHost): string {
	if ("report" in host) return `changed ${host.report.plugins.changed.join(", ")}`;
	if ("stopped" in host) return "stopped";
	return "failed";
}

// The example edits a plugin: it works on a copy of `plugins/`.
const root = await mkdtemp(join(tmpdir(), "chord-example-43-"));
await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });

const node = { platform: "node", hostPackages: ["@earendil-works/chord/next"] } as const;
const plugins = createPlugins(
	{ roots: [root], kinds: { server: node, worker: node }, onError: console.error },
	context,
);
const server = createHost({ address: hostKind("server")(), principal: { kind: "server" }, onError: console.error });
const workers = createWorkers(
	server,
	Session,
	{
		kind: "worker",
		entry: fileURLToPath(new URL("./worker.ts", import.meta.url)),
		execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
		authorize: () => true,
		principal: (address) => ({ kind: "worker", session: address.params.id }),
		start: () => ({}),
		lock: (address) => `example-43:${process.pid}:${address.key}`,
		plugins,
		onError: console.error,
	},
	context,
);
await plugins.load(server, { kind: "server", core: [], modules: { "@earendil-works/chord/next": chordNext } }, context);

// 1. The server's banner and two running sessions.
const banner = await server.get(Banner, {}, context);
const s1 = await server.get(Label, { id: "S1" }, context);
const s2 = await server.get(Label, { id: "S2" }, context);
console.log(`1. ${banner.text.value} | ${s1.text.value} | ${s2.text.value}`);

// 2. An edit: the watcher marks the plugin; one build serves both kinds.
await writeFile(join(root, "notes", "label.ts"), 'export const label = "v2";\n');
await waitUntil(() => plugins.state.value.dirty.includes("@example/notes"));
const built = await plugins.build(plugins.state.value.dirty, context);

// 3. The rollout: the server, then the workers (each running one reloads in parallel).
const result = await plugins.rollout([plugins.step("server", server), workers.step("workers")], built, context);
for (const step of result.steps) {
	for (const host of step.hosts) console.log(`2. ${step.name}: ${host.host} ${describe(host)}`);
}

// 4. Every host shows the new label (the workers' frames arrive over their links).
await waitUntil(() => s2.text.value === "S2: v2");
console.log(`3. ${banner.text.value} | ${s1.text.value} | ${s2.text.value}`);
console.log(`4. still dirty: ${JSON.stringify(plugins.state.value.dirty)}`);

banner.release();
s1.release();
s2.release();
await workers.close(context);
await server.close(context);
plugins.close();
await rm(root, { recursive: true, force: true });
