// What a facet may import (slice 7c §2). The build inlines a plugin's own files, files of other plugins (a copied
// contract) and its npm `dependencies`; it leaves host packages (the app's instances: an ES module's default and named
// exports, a CommonJS module), `chord.external` packages and Node builtins external, answered when the script runs; a
// plugin's own files are read through `pluginFile`. Here (`plugins/`): the report plugin uses each of these; its
// dependencies are installed first (`installDependencies`; `fake-npm.mjs` stands in for npm: no network). The ruler
// plugin copies a file that imports a package, the refused plugin imports what a script may not, and the paths plugin
// uses `__dirname` and `__filename`: they are left out with their build errors.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/37-plugin-imports/main.ts
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "../../../../src/context/index.ts";
import { createHost } from "../../../../src/next/host/index.ts";
import * as chordNext from "../../../../src/next/index.ts";
import { createPlugins } from "../../../../src/next-node/plugins/index.ts";
import * as app from "./app/index.ts";
import { Report } from "./plugins/shapes/contract.ts";

const context = BACKGROUND_CONTEXT;

// The example installs packages into a plugin: it works on a copy of `plugins/`, `app/` and `deps/` (the plugins'
// `file:` dependencies point there), removed at the end.
const copy = await mkdtemp(join(tmpdir(), "chord-example-37-"));
for (const dir of ["plugins", "app", "deps"]) {
	await cp(fileURLToPath(new URL(`./${dir}/`, import.meta.url)), join(copy, dir), { recursive: true });
}
const root = join(copy, "plugins");

// 1. The component. Its host packages: Chord, the app's ES module and a CommonJS module of the app. Its npm command
//    (here a stand-in): what `installDependencies` runs in a plugin's directory.
const plugins = createPlugins(
	{
		roots: [root],
		kinds: ["server"],
		hostPackages: {
			"@earendil-works/chord/next": chordNext,
			"@example/app": app,
			"@example/legacy": createRequire(import.meta.url)("./app/legacy.cjs"),
		},
		install: { npmCommand: [process.execPath, fileURLToPath(new URL("./fake-npm.mjs", import.meta.url))] },
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);

// 2. Startup: every plugin whose build fails is left out with its errors (one per line: file, line, column, why). The
//    report plugin's dependency is not installed yet.
const host = createHost({ onError: () => {} });
const loaded = await plugins.load(host, { kind: "server", core: [] }, context);
console.log("1. left out at startup:");
for (const { plugin, error } of loaded.failed) {
	const [first, ...errors] = (error as Error).message.split("\n");
	console.log(`   ${plugin}: ${first}`);
	for (const line of errors) console.log(`      ${line}`);
}

// 3. The report plugin's dependencies, installed into its own node_modules; then it builds, and a reload adds it.
await plugins.installDependencies("@example/report", context);
console.log("2. installed:", (await readdir(join(root, "report", "node_modules"))).join(", "));
const built = await plugins.build(["@example/report"], context);
for (const facet of built.facets) {
	if (facet.kind !== "script") continue;
	const files = facet.inputs.map(({ file }) => file.slice(root.length + 1));
	console.log(`   built ${facet.plugin}/${facet.facet}: read ${files.join(", ")}; copied ${facet.copied.length} file`);
}
const report = await plugins.reload(host, built, context);
console.log("   reload:", JSON.stringify(report.plugins), "failed", report.failed.length);
const text = (await host.get(Report, {}, context)).text.value;
console.log("3. the report:", text);

await host.close(context);
plugins.close();
await rm(copy, { recursive: true, force: true });
