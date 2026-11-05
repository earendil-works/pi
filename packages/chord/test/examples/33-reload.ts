// Reload in the kernel (slice 7b): `host.reload(facets, ctx)` switches a running host to a new plugin set. Staging
// runs every setup and every affected object's new factory against a recording `self` (nothing activates; a throw
// rejects the reload and nothing changes), the commit replaces the served types, registries and contributions at
// once, then every object of a changed or removed plugin takes its fate: a live one restarts (its running calls finish
// on the old code, new calls wait for the new code), a removed plugin's one ends. Here: a pure notes store restarts
// while a call runs on its old code, a search index with a native restarts after its running call drained, and a
// removed plugin's object ends while its holder waits for it to come back.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/33-reload.ts
import { BACKGROUND_CONTEXT, type Context } from "../../src/context/index.ts";
import { arr, int, local, method, obj, str } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type RefState } from "../../src/host/index.ts";
import { constant } from "../../src/state/index.ts";

const context = BACKGROUND_CONTEXT;

/** The notes store: a list, its count, and `add` (which can be told to wait, to show a call across a restart). */
const Notes = local("example.notes", {
	version: 1,
	params: {},
	members: { list: arr(str()), banner: str(), add: method(obj({ text: str() }), int()) },
});

/** A search index over the notes, holding a native (an index file, say). */
const Search = local("example.search", { version: 1, params: {}, members: { engine: str(), reindex: method() } });

/** A clock plugin, removed by the third reload. */
const Clock = local("example.clock", { version: 1, params: {}, members: { zone: str() } });

const List = defineState("example.list", {
	schema: obj({ list: arr(str()) }),
	version: 1,
	initial: () => ({ list: [] }),
});

let slowAdd: PromiseWithResolvers<void> | undefined;

/** The notes plugin, its banner and the text `add` prefixes differing per version: a pure object (no `self.open`). */
function notesPlugin(banner: string) {
	return defineFacet((host) =>
		host.serve(Notes, (_, self) => {
			const list = self.state(List);
			return {
				list: self.derive([list], ([value]) => value.list),
				banner: constant(banner),
				add: async ({ text }: { text: string }, ctx: Context) => {
					await slowAdd?.promise;
					await list.change((draft) => void draft.list.push(`${text} (${banner})`), ctx);
					return list.value.list.length;
				},
			};
		}),
	);
}

let slowReindex: PromiseWithResolvers<void> | undefined;

/** The search plugin: its engine is a native, so every reload of it restarts the object. */
function searchPlugin(engine: string) {
	return defineFacet((host) =>
		host.serve(Search, (_, self) => {
			const index = self.open(
				async () => {
					console.log(`  search: ${engine} opened`);
					return engine;
				},
				(value, reason) => console.log(`  search: ${value} closed (${reason.kind})`),
			);
			return {
				engine: constant(engine),
				reindex: async () => {
					console.log(`  search: reindex on ${index.value} started`);
					await slowReindex?.promise;
					console.log(`  search: reindex on ${index.value} done`);
					return null;
				},
			};
		}),
	);
}

const clockPlugin = defineFacet((host) => host.serve(Clock, () => ({ zone: constant("UTC") })));

/** Shows a reference's state as text. */
function shown(state: RefState): string {
	return state.kind === "failed" ? `failed { ${state.cause.kind} }: ${state.cause.error.message}` : state.kind;
}

// 1. A host with three plugins, loaded once. A reload passes the complete set; a facet passed as the very same object
// is an unchanged plugin (untouched), any other value for a loaded name a changed one.
const host = createHost({ onError: (error) => console.log(`  reported: ${error.kind}`) });
const search = searchPlugin("lucene");
const notesV2 = notesPlugin("v2");
const searchV2 = searchPlugin("tantivy");
await host.load(
	[
		{ name: "@example/notes", facet: notesPlugin("v1") },
		{ name: "@example/search", facet: search },
		{ name: "@example/clock", facet: clockPlugin },
	],
	context,
);
const notes = await host.get(Notes, {}, context);
await notes.add({ text: "first" }, context);
console.log("1. loaded:", notes.list.value, "banner", notes.banner.value);

// 2. A restart of pure code while a call runs: the running `add` finishes on the old code; the next call waits at the
// gate until the old attempt drained, then runs on the new code. Documents stay.
slowAdd = Promise.withResolvers();
const running = notes.add({ text: "second" }, context);
const restarted = await host.reload(
	[
		{ name: "@example/notes", facet: notesV2 },
		{ name: "@example/search", facet: search },
		{ name: "@example/clock", facet: clockPlugin },
	],
	context,
);
console.log("2. reload:", JSON.stringify(restarted));
const next = notes.add({ text: "third" }, context);
slowAdd.resolve();
slowAdd = undefined;
console.log("   the old call returned", await running, "; the waiting call, on the new code,", await next);
console.log("   list:", notes.list.value, "banner", notes.banner.value, "(same documents, new code)");

// 3. A restart: the search object holds a native. Its running call drains first, then the native closes (reload).
const index = await host.get(Search, {}, context);
slowReindex = Promise.withResolvers();
const reindexing = index.reindex(context);
await new Promise((resolve) => setTimeout(resolve, 0));
const restart = await host.reload(
	[
		{ name: "@example/notes", facet: notesV2 },
		{ name: "@example/search", facet: searchV2 },
		{ name: "@example/clock", facet: clockPlugin },
	],
	context,
);
console.log("3. reload:", JSON.stringify(restart.objects), "- the reference shows", shown(index.state.value));
slowReindex.resolve();
await reindexing;
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("   search now", shown(index.state.value), "on", index.engine.value);

// 4. A removal: the clock plugin is gone. Its object ends; its holder's request is not ended, it waits `not_served`.
const clock = host.hold(Clock, {}, context);
await new Promise((resolve) => setTimeout(resolve, 0));
const removal = await host.reload(
	[
		{ name: "@example/notes", facet: notesV2 },
		{ name: "@example/search", facet: searchV2 },
	],
	context,
);
console.log("4. reload:", JSON.stringify(removal.plugins), "- clock holder:", shown(clock.state.value));
console.log("   its last value stays readable:", clock.zone.value);

// 5. A later reload serves the clock again: the same holder binds again by itself.
await host.reload(
	[
		{ name: "@example/notes", facet: notesV2 },
		{ name: "@example/search", facet: searchV2 },
		{ name: "@example/clock", facet: clockPlugin },
	],
	context,
);
await new Promise((resolve) => setTimeout(resolve, 0));
console.log("5. served again: clock holder", shown(clock.state.value), clock.zone.value);

// 6. A staging error fails that plugin only: it keeps its old code, reported; nothing else changes.
const broken = defineFacet((h) =>
	h.serve(Notes, () => {
		throw new Error("a typo in the new factory");
	}),
);
const failed = await host.reload(
	[
		{ name: "@example/notes", facet: broken },
		{ name: "@example/search", facet: searchV2 },
		{ name: "@example/clock", facet: clockPlugin },
	],
	context,
);
console.log(
	"6. failed:",
	failed.failed.map(({ plugin, error }) => `${plugin}: ${(error as Error).message}`),
	"- banner still",
	notes.banner.value,
);

await host.close(context);
