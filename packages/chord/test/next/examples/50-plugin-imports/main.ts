// Imports between plugins (slice 12 §2, §3; decision "Contracts come from where the plugin's code came from"). A plugin
// carries the contract it was written against: plugins of one root (one repository, one commit) import each other's
// contract files by relative path, copied into the importer's script; a plugin of another repository takes them as a
// dependency pinned by an npm version or a git ref, inlined at the installed commit. Per-kind contract files
// (`contract.web.ts`) are for their kind only. Here: the app's root (`plugins/`, required) with notes, search (its server
// facet using notes' shared contract, its web facet notes' web file) and peek (a server facet reaching the web file
// through a helper: refused); the user's root (`user/`) with Bob's stats plugin, whose `@bob/words` dependency is pinned
// to the first commit of a local git repository (`words/` committed twice; no network), and reach (a relative path
// out of its root: refused).
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/50-plugin-imports/main.ts
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "../../../../src/context/index.ts";
import { int, local, str } from "../../../../src/next/contracts/index.ts";
import { createHost } from "../../../../src/next/host/index.ts";
import { createPlugins, PluginError } from "../../../../src/next-node/plugins/index.ts";
import * as v3server from "../49-plugin-api/app/v3/server.ts";
import * as v3 from "../49-plugin-api/app/v3.ts";

const context = BACKGROUND_CONTEXT;

// The example installs into a plugin: it works on a copy of its directories, removed at the end.
const copy = await mkdtemp(join(tmpdir(), "chord-example-50-"));
for (const dir of ["plugins", "user", "words"]) {
	await cp(fileURLToPath(new URL(`./${dir}/`, import.meta.url)), join(copy, dir), { recursive: true });
}

// 1. `@bob/words` in its own git repository: version 1 committed, then version 2. Bob pinned the first commit.
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.email=bob@example.com", "-c", "user.name=bob", ...args], { cwd, encoding: "utf8" });
const words = join(copy, "words");
git(words, "init", "--quiet");
git(words, "add", "--all");
git(words, "commit", "--quiet", "--message", "words 1");
const pinned = git(words, "rev-parse", "HEAD").trim();
const source = await readFile(join(words, "words.ts"), "utf8");
await writeFile(join(words, "words.ts"), source.replace('VERSION = "1"', 'VERSION = "2"'));
git(words, "commit", "--quiet", "--all", "--message", "words 2");
git(copy, "clone", "--quiet", "--bare", words, join(copy, "words.git"));
const stats = join(copy, "user", "stats", "package.json");
const manifest = JSON.parse(await readFile(stats, "utf8")) as { dependencies: Record<string, string> };
manifest.dependencies["@bob/words"] = `git+file://${join(copy, "words.git")}#${pinned}`;
await writeFile(stats, JSON.stringify(manifest, null, "\t"));
console.log("1. @bob/stats depends on", manifest.dependencies["@bob/words"].replace(copy, "…"));

// 2. The component: the app's root required, the user's not; the app's API (example 49's) for both kinds.
const plugins = createPlugins(
	{
		roots: [{ path: join(copy, "plugins"), required: true }, join(copy, "user")],
		api: { name: "@acme/app", versions: ["v3"] },
		kinds: {
			server: { platform: "node", hostPackages: ["@acme/app/v3", "@acme/app/v3/server"] },
			web: { platform: "browser", hostPackages: ["@acme/app/v3", "@acme/app/v3/web"] },
		},
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);

// 3. Bob's dependencies, installed by npm into his plugin's node_modules (a git dependency at a ref is npm's own).
await plugins.installDependencies("@bob/stats", context);

// 4. The server loads both roots. The peek plugin of the app's root fails: so the required root's load rejects (a
//    `PluginError`, after the load settled: the others are loaded), and the app decides (here: it reports and goes on).
const modules = { "@acme/app/v3": v3, "@acme/app/v3/server": v3server };
const host = createHost({ onError: () => {} });
try {
	await plugins.load(host, { kind: "server", core: [], modules }, context);
} catch (error) {
	if (!(error instanceof PluginError)) throw error;
	console.log("2. the load rejects:", error.name, "for", error.required.map(({ plugin }) => plugin).join(", "));
	for (const { plugin, error: cause } of error.failed) {
		console.log(`   ${plugin}: ${(cause as Error).message.split("\n").slice(1).join("; ")}`);
	}
}
const Search = local("acme.search", { version: 1, params: {}, members: { hits: int() } });
const Stats = local("bob.stats", { version: 1, params: {}, members: { text: str() } });
console.log("3. search hits:", (await host.get(Search, {}, context)).hits.value);
console.log("   stats:", (await host.get(Stats, {}, context)).text.value);

// 5. The search plugin's builds: what each copied from the notes plugin (its server facet the shared file, its web
//    facet the web file too).
const built = await plugins.build(["@acme/search"], context);
for (const facet of built.facets) {
	if (facet.kind !== "script") continue;
	const copied = facet.copied.map((file) => file.slice(copy.length + 1));
	console.log(`4. @acme/search ${facet.facet} copied: ${copied.join(", ")}`);
}

await host.close(context);
plugins.close();
await rm(copy, { recursive: true, force: true });
