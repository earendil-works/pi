// Single-file plugins (slice 12 §4, decision "Single-file plugins"). A file at a root's top named
// `<name>.<kind>.ts(x)` is a facet of the plugin `<name>`; files with one first name are one plugin. It has no
// `package.json`, so no dependencies: it imports the app's API only, defines its contracts inline, serves objects and
// contributes to registries. When it needs more, it becomes a directory with the same name, which a reload treats as
// the same plugin. Here (`plugins/`): `hello` (a server and a web file), `clock`, and `bad`, which imports another file
// and is refused; then `hello` becomes a directory with a helper file: the watcher marks the root, a build and a
// reload change the plugin `hello` in place.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/51-single-file-plugin/main.ts
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { local, str } from "../../../src/contracts/index.ts";
import { createHost } from "../../../src/host/index.ts";
import { createPlugins } from "../../../src/node/plugins/index.ts";
import * as v3server from "../49-plugin-api/app/v3/server.ts";
import * as v3 from "../49-plugin-api/app/v3.ts";

const context = BACKGROUND_CONTEXT;

// The example turns a file into a directory: it works on a copy of `plugins/`, removed at the end.
const root = await mkdtemp(join(tmpdir(), "chord-example-51-"));
await cp(fileURLToPath(new URL("./plugins/", import.meta.url)), root, { recursive: true });

/** Waits until `ready()` holds (the watcher's events arrive on their own time). */
async function until(ready: () => boolean): Promise<void> {
	while (!ready()) await new Promise((resolve) => setTimeout(resolve, 10));
}

// 1. The component, the server loaded: discovery found three single-file plugins; `bad` fails its build.
const plugins = createPlugins(
	{
		roots: [root],
		api: { name: "@acme/app", versions: ["v3"] },
		kinds: {
			server: { platform: "node", hostPackages: ["@acme/app/v3", "@acme/app/v3/server"] },
			web: { platform: "browser", hostPackages: ["@acme/app/v3", "@acme/app/v3/web"] },
		},
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);
const modules = { "@acme/app/v3": v3, "@acme/app/v3/server": v3server };
const host = createHost({ onError: () => {} });
const loaded = await plugins.load(host, { kind: "server", core: [], modules }, context);
for (const plugin of plugins.discovery.plugins) {
	const files = Object.values(plugin.facets).map((file) => file.slice(root.length + 1));
	console.log(`1. ${plugin.name} (${plugin.layout}): ${files.join(", ")}`);
}
for (const { plugin, error } of loaded.failed) {
	console.log(`   ${plugin} refused: ${(error as Error).message.split("\n").slice(1).join("; ")}`);
}
const Hello = local("example.hello", { version: 1, params: {}, members: { text: str() } });
const Clock = local("example.clock", { version: 1, params: {}, members: { text: str() } });
const hello = await host.get(Hello, {}, context);
console.log("2. hello:", hello.text.value, "| clock:", (await host.get(Clock, {}, context)).text.value);

// 2. `hello` needs a second file: it becomes the directory `hello/` (a package.json named `hello`), its files removed.
await mkdir(join(root, "hello"));
await writeFile(join(root, "hello", "package.json"), JSON.stringify({ name: "hello", type: "module" }));
await writeFile(join(root, "hello", "greeting.ts"), 'export const greeting = "hello from a directory";\n');
await writeFile(
	join(root, "hello", "server.ts"),
	[
		'import { constant, defineFacet, local, str } from "@acme/app/v3";',
		'import { greeting } from "./greeting.ts";',
		'const Hello = local("example.hello", { version: 1, params: {}, members: { text: str() } });',
		"export default defineFacet((host) => host.serve(Hello, () => ({ text: constant(greeting) })));",
	].join("\n"),
);
await rm(join(root, "hello.server.ts"));
await rm(join(root, "hello.web.ts"));
await until(() => plugins.state.value.set && plugins.state.value.dirty.includes("hello"));
console.log("3. marks:", JSON.stringify(plugins.state.value));

// 3. A build discovers again; the reload changes `hello` in place (the same plugin, its object swapped), a holder
//    sees the new text.
const built = await plugins.build(plugins.state.value.dirty, context);
const report = await plugins.reload(host, built, context);
console.log("4. reload:", JSON.stringify(report.plugins), "| hello:", hello.text.value);
console.log("   hello is now:", plugins.discovery.plugins.find(({ name }) => name === "hello")?.layout);

hello.release();
await host.close(context);
plugins.close();
await rm(root, { recursive: true, force: true });
