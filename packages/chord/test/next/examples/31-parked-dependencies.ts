// Parked dependencies (dependency model, slice 7a): a reference is a request that outlives every provider it meets. An
// object whose dependency is not there yet is parked, not failed: it shows `failed { waiting }` naming what it waits
// for (the nearest blocker and the root cause), no timer runs for it, its factory is not run again, and it goes on the
// moment its dependency is live. Here a tab's panel needs `Notes` from a server that does not serve it yet; the server
// restarts with the notes plugin, the tab reconnects, and the panel goes live without anyone asking.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/31-parked-dependencies.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { arr, hostKind, int, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { isChordError } from "../../../src/next/data/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type RefState } from "../../../src/next/host/index.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";
import type { NativeWatchable } from "../../../src/watch.ts";

const context = BACKGROUND_CONTEXT;
const started = Date.now();
const at = (): string => `${((Date.now() - started) / 1000).toFixed(1)} s`;

type Principal = { readonly kind: "server" } | { readonly kind: "owner" };

const Server = hostKind("server");

/** The server's notes (the notes plugin), placed on the server. */
const Notes = remote("example.notes", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { editor: { state: { list: arr(str()) }, methods: { add: method(obj({ text: str() })) } } },
});

/** A panel in the tab: a local object over the server's notes. */
const Panel = local("example.panel", { version: 1, params: { id: int() }, members: { count: int() } });

/** A local object the panel's sibling needs, which no plugin of the tab serves. */
const Theme = local("example.theme", { version: 1, params: {}, members: { name: str() } });
const Header = local("example.header", { version: 1, params: { id: int() }, members: { title: str() } });

const List = defineState("example.list", {
	schema: obj({ list: arr(str()) }),
	version: 1,
	initial: () => ({ list: [] }),
});

/** The notes plugin's server facet. */
const notesPlugin = defineFacet<Principal>((host) => {
	host.serve(Notes, (_params, _principal, self) => {
		const list = self.state(List);
		return {
			variant: "editor",
			members: {
				list: self.derive([list], ([l]) => l.list),
				add: async ({ text }, ctx) => {
					await list.change((draft) => void draft.list.push(text), ctx);
					return null;
				},
			},
		};
	});
});

/** A server with the given plugins, its link to the tab accepted. */
async function startServer(plugins: { readonly name: string; readonly facet: typeof notesPlugin }[]) {
	const server = createHost<Principal>({ address: Server(), principal: { kind: "server" }, onError: () => {} });
	await server.load(plugins, context);
	const [up, down] = memoryLinkPair();
	server.accept(up, { principal: { kind: "owner" } }, context);
	return { server, tabLink: down, close: () => up.close() };
}

// The tab: its panel declares the notes (a dependency); its header a theme nobody serves.
let panels = 0;
const tab = createHost<Principal>({ onError: (error) => console.log(`${at()}: reported ${error.kind}`) });
await tab.load(
	[
		{
			name: "@example/panel",
			facet: defineFacet<Principal>((host) => {
				host.serve(Panel, (_, self) => {
					panels++;
					const notes = self.get(Notes, {});
					return { count: self.derive([notes.list], ([list]) => list.length) };
				});
				host.serve(Header, (_, self) => ({ title: self.get(Theme, {}).name }));
			}),
		},
	],
	context,
);

/** Prints every state of `state` as it changes. */
async function follow(label: string, state: NativeWatchable<RefState>): Promise<void> {
	const watch = await state.watch(context);
	watch.start(async (call) => {
		if (call.kind === "value") console.log(`${at()}: ${label} ${describe(call.value)}`);
	});
}

function describe(state: RefState): string {
	if (state.kind !== "failed") return state.kind;
	return `failed { ${state.cause.kind} }: ${state.cause.error.message}`;
}

// 1. The first server has no notes plugin. Its answer is `failed { waiting }`: not the panel's fault.
const first = await startServer([]);
tab.connect(first.tabLink, { principal: { kind: "server" } }, context);
const panel = tab.hold(Panel, { id: 1 }, context);
await follow("panel:", panel.state);
await new Promise((resolve) => setTimeout(resolve, 10));
console.log(`${at()}: panel now ${describe(panel.state.value)}`);

// 2. A local type nobody serves here is the same answer: the request waits unbound, indexed under the type's name.
const header = tab.hold(Header, { id: 1 }, context);
await new Promise((resolve) => setTimeout(resolve, 10));
console.log(`${at()}: header ${describe(header.state.value)}`);

// 3. A getter waits through `waiting` up to its readyTimeout, then rejects with the cause (a hold just shows it).
try {
	await tab.get(Panel, { id: 1 }, context, { readyTimeout: 200 });
} catch (error) {
	if (isChordError(error)) console.log(`${at()}: get gave up after 200 ms: ${error.message}`);
}

// 4. Time passes: no timer runs for the parked panel, its factory is not run again.
await new Promise((resolve) => setTimeout(resolve, 1500));
console.log(`${at()}: still ${panel.state.value.kind}, factory runs: ${panels}`);

// 5. The server restarts with the notes plugin (the link drop shows as loading); the tab reconnects: its request is
// held again and binds, and the parked panel goes on.
first.close();
await new Promise((resolve) => setTimeout(resolve, 10));
const second = await startServer([{ name: "@example/notes", facet: notesPlugin }]);
tab.connect(second.tabLink, { principal: { kind: "server" } }, context);
const live = await tab.get(Panel, { id: 1 }, context);
console.log(`${at()}: panel live, count ${live.count.value}, factory runs: ${panels}`);
// The panel's notes are the owner's object on the server (a remote object per principal): the tab adds through its own.
const notes = await tab.get(Notes, {}, context);
await notes.add({ text: "first" }, context);
await new Promise((resolve) => setTimeout(resolve, 10));
console.log(`${at()}: panel count ${live.count.value}`);

header.release();
panel.release();
live.release();
notes.release();
await tab.close(context);
await second.server.close(context);
await first.server.close(context);
