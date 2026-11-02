// Registries: an extension point between plugins. The defining plugin shares a token (`defineRegistry`: a name, a
// version, the contribution and value types) and serves it with `compose`, a pure function from the table of
// contributions (sorted by plugin name, never load order) to one value, conflicts resolved by a fallback and reported
// (`registry_conflict`). Facets and host-lifetime objects contribute one value each: a plain value, or a watchable
// (`self.writable`) whose changes recompose. Readers follow the composed value (`self.registry`, a dependency like
// `self.get`; `host.registry` outside objects) and guard each contribution where they call it.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/29-registries.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { defineRegistry, keyedEntries, type TableItem } from "../../../src/next/registries/index.ts";

const context = BACKGROUND_CONTEXT;

// 1. The token, shared by every plugin (bundled like a contract): routes in, a router out.
type Handler = (path: string) => string;
type Routes = { readonly routes: Readonly<Record<string, Handler>> };
type Router = ReadonlyMap<string, TableItem<Handler>>;
const Http = defineRegistry<Routes, Router>("example.http", { version: 1 });

/** The HTTP server: it reads the router at each request and guards the contribution it calls. */
const Server = local("example.server", {
	version: 1,
	params: {},
	members: { request: method(obj({ path: str() }), str()) },
});

/** A plugin whose routes are known only at runtime: it contributes a writable it sets. */
const Mounts = local("example.mounts", { version: 1, params: {}, members: { mount: method(obj({ path: str() })) } });

// 2. The defining plugin serves the registry: the first route by plugin name wins, a duplicate is reported.
const httpPlugin = defineFacet((host) => {
	host.serve(Http, { compose: (table, { report }) => keyedEntries(table, (entry) => entry.routes, report) });
	host.serve(Server, (_, self) => {
		const router = self.registry(Http);
		return {
			request: async ({ path }) => {
				const route = router.value.get(path);
				if (route === undefined) return "404";
				// A contribution is another plugin's code: catch, report its plugin, go on.
				try {
					return route.value(path);
				} catch (error) {
					console.log(`route ${path} of ${route.plugin} threw:`, (error as Error).message);
					return "500";
				}
			},
		};
	});
});

// 3. Two plugins contribute from their facets: plain values, in the table while the plugin is loaded.
const notesPlugin = defineFacet((_, self) => {
	self.contribute(Http, { routes: { "/notes": () => "notes", "/broken": () => JSON.parse("{") } });
});
const searchPlugin = defineFacet((_, self) => {
	self.contribute(Http, { routes: { "/search": () => "results", "/notes": () => "search's notes" } });
});

// 4. A host-lifetime object contributes a writable: its changes recompose the router.
const mountsPlugin = defineFacet((host) => {
	host.serve(Mounts, (_, self) => {
		const routes = self.writable<Routes>({ routes: {} });
		self.contribute(Http, routes);
		return {
			mount: async ({ path }) => {
				routes.set({ routes: { ...routes.value.routes, [path]: () => `mounted ${path}` } });
				return null;
			},
		};
	});
});

const host = createHost({
	onError: (error) => {
		if (error.kind === "registry_conflict") console.log("conflict:", error.message, error.plugins);
		else console.log("onError:", error.kind);
	},
});

// 5. A reader before `load` waits: the provider comes with `load`, which composes every registry before any object.
const early = host.registry(Http, context);
await host.load(
	[
		{ name: "@example/http", facet: httpPlugin },
		{ name: "@example/notes", facet: notesPlugin },
		{ name: "@example/search", facet: searchPlugin },
		{ name: "@example/mounts", facet: mountsPlugin },
	],
	context,
);
const router = await early;
console.log(
	"routes:",
	[...router.value].map(([path, { plugin }]) => `${path} (${plugin})`),
);

// 6. Requests: a duplicate went to the first plugin by name; a throwing contribution is guarded at the use site.
const server = await host.get(Server, {}, context);
console.log("/notes ->", await server.request({ path: "/notes" }, context));
console.log("/broken ->", await server.request({ path: "/broken" }, context));

// 7. A watch of the composed value gets each new router; mounting recomposes it.
const watch = await router.watch(context);
watch.start(async (call) => {
	if (call.kind === "value") console.log("router now has:", [...call.value.keys()]);
});
const mounts = await host.get(Mounts, {}, context);
await mounts.mount({ path: "/files" }, context);
await new Promise((resolve) => setTimeout(resolve, 0));
console.log("/files ->", await server.request({ path: "/files" }, context));

await watch.stop();
await host.close(context);
