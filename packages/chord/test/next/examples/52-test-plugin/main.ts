// Testing a plugin alone (slice 12 §6, decision "Testing a plugin alone"). `testPlugin(dir, options, ctx)` builds the
// plugin as production does (the same build, the app's API checked), evaluates it with the app's real API modules and
// loads it on an in-memory host (a `:memory:` store) beside stubs: ordinary facets serving the contracts it uses with
// fake data. Registries it contributes to that nobody serves are served by the helper, which collects the entries;
// contracts its requests wait for unserved are listed. Here (`plugins/`): the stats plugin, with a stub for the notes
// plugin, its indexer read from the collected `Indexers`, and the `Tags` contract it waits for listed.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/52-test-plugin/main.ts
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "../../../../src/context/index.ts";
import { testPlugin } from "../../../../src/next-node/plugins/index.ts";
import * as v3worker from "../49-plugin-api/app/v3/worker.ts";
import * as v3 from "../49-plugin-api/app/v3.ts";

const context = BACKGROUND_CONTEXT;

// The contracts the test uses, declared again with the API's builders (contracts are data: the same name, version and
// schema bind). The plugins' own files import `@acme/app/v3`, a host package this process has no module path for.
const Notes = v3.local("acme.notes", { version: 1, params: { project: v3.str() }, members: { text: v3.str() } });
const Stats = v3.local("acme.stats", { version: 1, params: { project: v3.str() }, members: { words: v3.int() } });
const TagLine = v3.local("acme.tag-line", { version: 1, params: { project: v3.str() }, members: { text: v3.str() } });

/** The worker host's principal type, and a user's. */
type Principal = { readonly kind: "worker"; readonly project: string } | { readonly kind: "user"; readonly id: string };

// 1. A stub of the notes plugin: an ordinary facet serving `Notes` with a fixed text for every project.
const notesStub = v3.defineFacet<Principal>((host) =>
	host.serve(Notes, ({ project }) => ({ text: v3.constant(`${project}: buy milk, call bob, ship it`) })),
);

// 2. The plugin on a worker host of its own, acting as the worker's principal; the app's API as production has it.
const t = await testPlugin<Principal>(
	fileURLToPath(new URL("./plugins/stats/", import.meta.url)),
	{
		kind: "worker",
		kinds: ["server", "worker", "web"],
		api: { name: "@acme/app", versions: ["v3"] },
		modules: { "@acme/app/v3": v3, "@acme/app/v3/worker": v3worker },
		stubs: [{ name: "@acme/notes", facet: notesStub }],
		principal: { kind: "worker", project: "p1" },
	},
	context,
);

// 3. Its objects are live: get them, read their state.
const stats = await t.host.get(Stats, { project: "p1" }, context);
console.log("1. words in p1:", stats.words.value);

// 4. What it contributed to `Indexers`, a registry of the app no stub serves: collected by the helper.
console.log(
	"2. indexers:",
	t.contributions(v3worker.Indexers).map(({ plugin, value }) => `${value.name} (${plugin})`),
);

// 5. A contract nobody serves: its requests wait, and the helper names it, so the test knows what to stub next.
const tags = t.host.hold(TagLine, { project: "p1" }, context);
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("3. waiting for:", t.unserved(), "| tag line:", tags.state.value.kind);

// 6. Code outside objects as another principal (a user), and as the host's own.
const who = (principal: Principal | undefined) => (principal === undefined ? "nobody" : JSON.stringify(principal));
console.log("4. root as the host:", who(await t.root(async (ctx) => ctx.principal, context)));
const user = { kind: "user", id: "u1" } as const;
console.log("   root as a user:", who(await t.root(async (ctx) => ctx.principal, context, { principal: user })));

stats.release();
tags.release();
await t.close(context);
