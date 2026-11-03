// The app's versioned API (slice 12 §1, decision "Plugins import only the app's versioned API"). Plugins import their
// host only through the app's API modules, a version in the path: `@acme/app/v3` (shared by every kind) and its
// per-kind modules (`@acme/app/v3/server`, `/v3/web`); the app lists the versions it still provides (`api.versions`)
// and each kind's modules (`kinds.<kind>.hostPackages`). Here (`plugins/`, the API in `app/`): a v3 plugin and a v2
// plugin both load (v2 is a thin layer over v3); refused at build, each with its error: a v1 plugin (no longer
// provided), a facet mixing v2 and v3, a direct import of Chord, a server facet importing the web's module.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/49-plugin-api/main.ts
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { createHost, defineFacet } from "../../../src/host/index.ts";
import { createPlugins, evaluateFacet } from "../../../src/node/plugins/index.ts";
import * as v2 from "./app/v2.ts";
import * as v3server from "./app/v3/server.ts";
import * as v3web from "./app/v3/web.ts";
import * as v3 from "./app/v3.ts";

const context = BACKGROUND_CONTEXT;
const root = fileURLToPath(new URL("./plugins/", import.meta.url));

// 1. The component with the app's API: its name and versions (newest first), and per kind the modules its facets may
//    import. Chord is no host package of plugins: the API re-exports what Acme supports of it.
const plugins = createPlugins(
	{
		roots: [{ path: root, required: false }],
		api: { name: "@acme/app", versions: ["v3", "v2"] },
		kinds: {
			server: { platform: "node", hostPackages: ["@acme/app/v3", "@acme/app/v3/server", "@acme/app/v2"] },
			web: { platform: "browser", hostPackages: ["@acme/app/v3", "@acme/app/v3/web", "@acme/app/v2"] },
		},
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);

// 2. The server's modules (this process's instances) and its own start-data facet, base code: it serves the
//    `Greetings` registry, composing the lines in plugin-name order.
const modules = { "@acme/app/v3": v3, "@acme/app/v3/server": v3server, "@acme/app/v2": v2 };
const core = defineFacet((host) => host.serve(v3.Greetings, { compose: (table) => table.map(({ value }) => value) }));
const host = createHost({ onError: () => {} });
const loaded = await plugins.load(
	host,
	{ kind: "server", core: [{ name: "@acme/core", facet: core }], modules },
	context,
);

// 3. Who loaded, and who was refused (each build error names the file, line and rule).
console.log("1. greetings:");
for (const line of (await host.registry(v3.Greetings, context)).value) console.log(`   ${line}`);
console.log("2. refused at build:");
for (const { plugin, error } of loaded.failed) {
	const [, ...errors] = (error as Error).message.split("\n");
	console.log(`   ${plugin}: ${errors.join("; ")}`);
}

// 4. The web kind provides `/v3/web`: the panel plugin's web facet builds, and a page (here a host in this process,
//    given the web's modules) evaluates and loads it.
const built = await plugins.build(["@acme/panel"], context);
console.log("3. the panel plugin:", built.facets.map((facet) => `${facet.facet} ${facet.kind}`).join(", "));
const web = built.facets.find((facet) => facet.facet === "web" && facet.kind === "script");
if (web?.kind === "script") {
	const webModules = { "@acme/app/v3": v3, "@acme/app/v3/web": v3web, "@acme/app/v2": v2 };
	const panels = defineFacet((h) =>
		h.serve(v3web.Panels, { compose: (table) => table.map(({ value }) => value.title) }),
	);
	const page = createHost({ onError: () => {} });
	const facet = evaluateFacet(web, { hostPackages: webModules, plugin: built.plugins["@acme/panel"]! });
	await page.load(
		[
			{ name: "@acme/page", facet: panels },
			{ name: "@acme/panel", facet },
		],
		context,
	);
	console.log("   panels on the page:", (await page.registry(v3web.Panels, context)).value.join(", "));
	await page.close(context);
}

await host.close(context);
plugins.close();
