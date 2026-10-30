// The watcher's marks and rollouts (slice 7c §5). The watcher marks what changed and never applies it: `dirty` for a
// plugin whose file changed (a contract file: every plugin that copies it), `install` for a changed `package.json`,
// `set` when a plugin directory or facet file is added or removed, `base` when the app's own code changes. The app
// builds the dirty plugins and rolls the build out over its hosts in order; a rollout clears the marks of the plugins
// it applied on every step. Here: a plugin added, one removed and one dropping its worker facet in one rollout; a
// rollout stopping at a step that rejects; a failed plugin staying dirty while the others clear; an edit during a build
// keeping its mark.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/38-watch-and-rollout/main.ts
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "../../../../src/context/index.ts";
import { createHost, type Host, type ReloadReport } from "../../../../src/next/host/index.ts";
import * as chordNext from "../../../../src/next/index.ts";
import { createPlugins, type RolloutResult, type RolloutStep } from "../../../../src/next-node/plugins/index.ts";

const context = BACKGROUND_CONTEXT;

// The example edits files: it works on a copy of `plugins/` and `app/`, removed at the end.
const copy = await mkdtemp(join(tmpdir(), "chord-example-38-"));
for (const dir of ["plugins", "app"]) {
	await cp(fileURLToPath(new URL(`./${dir}/`, import.meta.url)), join(copy, dir), { recursive: true });
}
const root = join(copy, "plugins");

/** Waits until `ready()` holds (the watcher's events arrive on their own time). */
async function until(ready: () => boolean): Promise<void> {
	while (!ready()) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Replaces `from` with `to` in `file` (under the copy). */
async function edit(file: string, from: string, to: string): Promise<void> {
	const text = await readFile(join(copy, file), "utf8");
	await writeFile(join(copy, file), text.replace(from, to));
}

/** Waits until every plugin of `names` is marked dirty. */
const dirty = (...names: string[]) => until(() => names.every((name) => plugins.state.value.dirty.includes(name)));

/** The marks, in one line. */
const marks = () => JSON.stringify(plugins.state.value);

/** What a step's report says, in one line. */
const line = (report: ReloadReport) =>
	JSON.stringify({ ...report.plugins, failed: report.failed.map(({ plugin }) => plugin) });

/** A rollout, step by step. */
function print(result: RolloutResult): void {
	for (const { name, report } of result.steps) console.log(`   ${name}:`, line(report));
	if (result.stopped !== undefined) {
		console.log(`   stopped at ${result.stopped.step}: ${(result.stopped.error as Error).message}`);
	}
}

const plugins = createPlugins(
	{
		roots: [root],
		kinds: ["server", "worker"],
		hostPackages: { "@earendil-works/chord/next": chordNext },
		// The app's own code: a change marks `base`.
		base: [join(copy, "app")],
		// A stand-in for npm (no network; these plugins have no dependencies).
		install: { npmCommand: [process.execPath, "-e", ""] },
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);
const server = createHost({ onError: () => {} });
const worker = createHost({ onError: () => {} });
await plugins.load(server, { kind: "server", core: [] }, context);
await plugins.load(worker, { kind: "worker", core: [] }, context);
const steps = [plugins.step("server", server as Host), plugins.step("worker", worker as Host)];
console.log("1. loaded:", plugins.discovery.plugins.map(({ name }) => name).join(", "), "| marks:", marks());

// 2. Each kind of change and its mark.
await edit("plugins/notes/label.ts", "notes v1", "notes v2");
await dirty("@example/notes");
console.log("2. a file of notes edited:", marks());
await edit("plugins/contracts/contract.ts", "one type per plugin", "one type per plugin (edited)");
await dirty("@example/contracts", "@example/tags");
console.log("   the shared contract edited:", marks());
await edit("plugins/tags/package.json", '"private": true', '"private": true,\n\t"description": "tags"');
await until(() => plugins.state.value.install.includes("@example/tags"));
console.log("   tags' package.json edited:", marks());
await plugins.installDependencies("@example/tags", context);
console.log("   tags installed:", marks());
await cp(fileURLToPath(new URL("./incoming/extra/", import.meta.url)), join(root, "extra"), { recursive: true });
await rm(join(root, "old"), { recursive: true });
await rm(join(root, "tags", "worker.ts"));
await until(() => plugins.state.value.set);
// Deleting old's directory deleted its package.json too: an install mark, which goes with the next discovery.
console.log("   extra added, old removed, tags' worker facet deleted:", marks());
await edit("app/config.ts", '"example"', '"example 2"');
await until(() => plugins.state.value.base);
console.log("   the app's own code edited:", marks());

// 3. One build of the dirty plugins (discovery runs again first: `set`), rolled out server then worker. The server adds
//    extra and removes old; the worker leaves tags out (it has no worker facet any more). The marks clear, but `base`:
//    that one is the app's to act on (it restarts its hosts).
const built = await plugins.build(plugins.state.value.dirty, context);
console.log("3. built:", built.facets.map(({ plugin, facet }) => `${plugin}/${facet}`).join(", "));
console.log("   removed:", JSON.stringify(built.removed));
print(await plugins.rollout(steps, built, context));
console.log("   marks:", marks());

// 4. A rollout stops at a step that rejects (a host the app cannot reach): the steps after it do not run, and the marks
//    stay (the plugin was not applied everywhere). The next rollout clears them.
const unreachable: RolloutStep = {
	name: "edge",
	kinds: ["server"],
	reload: async () => {
		throw new Error("the edge host is unreachable");
	},
};
await edit("plugins/notes/label.ts", "notes v2", "notes v3");
await dirty("@example/notes");
const notes = await plugins.build(plugins.state.value.dirty, context);
console.log("4. rollout over server, edge, worker:");
print(await plugins.rollout([steps[0]!, unreachable, steps[1]!], notes, context));
console.log("   marks:", marks());
print(await plugins.rollout(steps, notes, context));
console.log("   marks after the next rollout:", marks());

// 5. A failed plugin stays dirty, the others clear: notes gets a syntax error, tags a good edit.
await edit("plugins/notes/label.ts", '"notes v3"', '"notes v4" +');
await edit("plugins/tags/server.ts", "tags on the server", "tags v2 on the server");
await dirty("@example/notes", "@example/tags");
console.log("5. notes broken, tags edited:");
print(await plugins.rollout(steps, await plugins.build(plugins.state.value.dirty, context), context));
console.log("   marks:", marks());

// 6. An edit after the build started keeps its mark: the rollout applies the build, but the newer edit is not in it.
await edit("plugins/notes/label.ts", '"notes v4" +', '"notes v4"');
await dirty("@example/notes");
const early = await plugins.build(plugins.state.value.dirty, context);
await edit("plugins/notes/label.ts", '"notes v4"', '"notes v5"');
// The edit's event arrives on its own time (the mark is set already, so no change shows it).
await new Promise((resolve) => setTimeout(resolve, 200));
console.log("6. built before the second edit:");
print(await plugins.rollout(steps, early, context));
console.log("   marks:", marks());
print(await plugins.rollout(steps, await plugins.build(plugins.state.value.dirty, context), context));
console.log("   marks after building again:", marks());

await server.close(context);
await worker.close(context);
plugins.close();
await rm(copy, { recursive: true, force: true });
