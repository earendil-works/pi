// Plugin failures (slice 7c): every failure is per plugin. At startup a plugin whose setup throws is left out and the
// others run (a consumer of what it would serve waits). At a reload a plugin whose new code fails keeps its old code and
// is listed in the report's `failed`: a syntax error (its build failed), a module that throws while it is evaluated
// (`mapStack` names the plugin's file and line), a factory that throws while the host stages it. The closure rule: a
// provider and its consumer edited together, the provider broken, the consumer kept on its old code too (its new code
// needs the provider's new version) and still working; the next good edit applies both. Last, a reload whose context
// aborts after its commit: the commit stands, and the component keeps what was committed.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/36-plugin-failures/main.ts
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, withAbortSignal } from "../../../../src/context/index.ts";
import { int, local, str } from "../../../../src/next/contracts/index.ts";
import { isChordError } from "../../../../src/next/data/index.ts";
import { createHost, type ReloadReport } from "../../../../src/next/host/index.ts";
import * as chordNext from "../../../../src/next/index.ts";
import { createPlugins, mapStack } from "../../../../src/next-node/plugins/index.ts";
import { Weather } from "./plugins/weather/contract.ts";

const context = BACKGROUND_CONTEXT;

// The example edits files: it works on a copy of `plugins/`, removed at the end.
const root = await mkdtemp(join(tmpdir(), "chord-example-36-"));
await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });

/** Waits until `ready()` holds (the watcher's events arrive on their own time). */
async function until(ready: () => boolean): Promise<void> {
	while (!ready()) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Replaces `from` with `to` in the plugin file `file` (the copy). */
async function edit(file: string, from: string, to: string): Promise<void> {
	const text = await readFile(join(root, file), "utf8");
	await writeFile(join(root, file), text.replace(from, to));
}

/** Waits until the watcher marks every plugin in `names` dirty, then builds the dirty plugins. */
async function buildDirty(names: readonly string[]) {
	await until(() => names.every((name) => plugins.state.value.dirty.includes(name)));
	return plugins.build(plugins.state.value.dirty, context);
}

/** A reload's report: what changed, its objects' fates, and each failed plugin with its error's mapped stack. */
function print(report: ReloadReport): void {
	console.log("   plugins:", JSON.stringify(report.plugins));
	const objects = report.objects.map((each) => `${each.object} ${each.kind}`);
	if (objects.length > 0) console.log("   objects:", objects.join(", "));
	for (const { plugin, error } of report.failed) {
		// The first line, and the second where it names the plugin's code: a build error, or a mapped stack frame.
		const [message, next = ""] = mapStack(error).split("\n");
		const detail = !next.trimStart().startsWith("at ") || next.includes("/server.ts:") ? ` ${next.trim()}` : "";
		console.log(`   failed ${plugin}: ${message}${detail}`);
	}
}

// The contracts the app reads (the plugins declare the same ones).
const Forecast = local("example.forecast", { version: 1, params: {}, members: { text: str() } });
const Greeting = local("example.greeting", { version: 1, params: {}, members: { text: str() } });
const Boot = local("example.boot", { version: 1, params: {}, members: { mode: str() } });
const Counter = local("example.counter", { version: 1, params: {}, members: { start: int() } });
const Summary = local("example.summary", { version: 1, params: {}, members: { text: str() } });
const Status = local("example.status", { version: 1, params: {}, members: { text: str() } });

const plugins = createPlugins(
	{
		roots: [root],
		kinds: ["server"],
		hostPackages: { "@earendil-works/chord/next": chordNext },
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);
const host = createHost({ onError: () => {} });

// 1. Startup: the weather plugin's setup throws; it is left out and reported, the other plugins run. A reference to
//    what it would serve waits (`failed`, cause `waiting`: not served here), and so does its consumer's object.
const loaded = await plugins.load(host, { kind: "server", core: [] }, context);
for (const { plugin, error } of loaded.failed) console.log(`1. left out ${plugin}: ${(error as Error).message}`);
const weather = host.hold(Weather, {}, context);
const forecast = host.hold(Forecast, {}, context);
await until(() => forecast.state.value.kind === "failed");
console.log("   weather:", JSON.stringify(weather.state.value));
console.log("   forecast:", JSON.stringify(forecast.state.value));
const greeting = await host.get(Greeting, {}, context);
const boot = await host.get(Boot, {}, context);
const counter = await host.get(Counter, {}, context);
const summary = await host.get(Summary, {}, context);
const status = await host.get(Status, {}, context);
const values = () =>
	[greeting.text.value, boot.mode.value, counter.start.value, summary.text.value]
		.map((v) => JSON.stringify(v))
		.join(" ");
console.log("   running:", values());

// 2. Four bad edits at once. The greeter's label gets a syntax error; the boot module throws while it is evaluated;
//    the counter's factory throws; the prices plugin moves its contract to version 2 and breaks its facet in the same
//    edit, while the summary plugin (its copy of the contract now at version 2) builds fine.
await edit("greeter/label.ts", '"hello"', '"hello" +');
await edit("boot/server.ts", "const Boot", 'throw new Error("boot: config missing");\n\nconst Boot');
await edit("counter/server.ts", "() => ({ start: constant(1) })", '() => {\n\tthrow new Error("counter: no seed");\n}');
await edit("prices/contract.ts", "version: 1", "version: 2");
await edit("prices/server.ts", "constant(250)", "constant(250");
const bad = await buildDirty(["@example/greeter", "@example/boot", "@example/counter", "@example/summary"]);
console.log("2. built:", bad.facets.map(({ plugin, kind }) => `${plugin}: ${kind}`).join(", "));
// Each failed plugin keeps its old code; the summary's new code would ask for `Price` v2, which only the prices
// plugin's new (failed) code serves: the closure rule keeps the summary on its old code too.
print(await plugins.reload(host, bad, context));
console.log("   running:", values());
console.log("   still dirty:", JSON.stringify(plugins.state.value.dirty));

// 3. The fixes: the next build and reload apply every plugin, the prices provider and its consumer together.
await edit("greeter/label.ts", '"hello" +', '"hi"');
await edit("boot/server.ts", 'throw new Error("boot: config missing");\n\n', "");
await edit("boot/server.ts", 'constant("v1")', 'constant("v2")');
await edit("counter/server.ts", '() => {\n\tthrow new Error("counter: no seed");\n}', "() => ({ start: constant(2) })");
await edit("prices/server.ts", "constant(250", "constant(300)");
const good = await buildDirty(["@example/greeter", "@example/boot", "@example/counter", "@example/prices"]);
console.log("3. fixed:");
print(await plugins.reload(host, good, context));
console.log("   running:", values());
// The summary's new code waited for the new `Price` object (parked at the report): it runs once that one is live.
await until(() => summary.text.value.startsWith("price v2"));
console.log("   then:", values());

// 4. A reload whose context aborts after its commit, while it waits for its report: here the app shuts down the moment
//    it sees the status object leave `live` (its new code waits for a new `Cache`, which takes 200 ms to open). The
//    reload rejects `aborted`, but its commit stands: `details.committed` says what it applied, and the component's
//    loaded set is what was committed (a later reload does not roll the cache plugin back).
console.log("4. status:", status.text.value);
await edit("cache/server.ts", 'const generation = "v1"', 'const generation = "v2"');
const cache = await buildDirty(["@example/cache"]);
const abort = new AbortController();
const watchStatus = await status.state.watch(context);
watchStatus.start(async (call) => {
	if (call.kind !== "value") return;
	console.log("   the status reference:", call.value.kind);
	if (call.value.kind !== "live") abort.abort(new Error("the app shuts down"));
});
try {
	await plugins.reload(host, cache, withAbortSignal(abort.signal, context));
} catch (error) {
	if (!isChordError(error, "aborted")) throw error;
	console.log("   rejected:", error.code, error.message, JSON.stringify(error.details));
}
await until(() => status.text.value === "cache v2");
console.log("   status:", status.text.value);
await edit("greeter/label.ts", '"hi"', '"hey"');
print(await plugins.reload(host, await buildDirty(["@example/greeter"]), context));
console.log("   after another reload:", status.text.value, "| greeting:", greeting.text.value);

await watchStatus.stop();
await host.close(context);
plugins.close();
await rm(root, { recursive: true, force: true });
