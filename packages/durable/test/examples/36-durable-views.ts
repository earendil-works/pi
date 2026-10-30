// Durable's views as Chord sources: `self.follow(attach)` turns Durable's synchronous observers (the conversation view,
// the task graph) into watchables, members and derive sources of the object that opened Durable. With Durable on the
// host's store, Durable adopts its commits inside the store's commit step, in the host's batch: a derive over two views
// of one commit computes once, and a watcher gets one frame per commit.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/36-durable-views.ts

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	arr,
	createHost,
	defineFacet,
	int,
	local,
	method,
	obj,
	openStore,
	sqliteBackend,
	str,
} from "@earendil-works/chord/next";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, ROOT_CONVERSATION_ID } from "../../src/index.ts";
import { StoreStorage } from "../../src/storage/store/index.ts";

const context = BACKGROUND_CONTEXT;

const Chat = local("example.chat", {
	version: 1,
	params: {},
	members: {
		// What a UI shows: the kinds of the transcript's entries and the number of tasks, from two views.
		summary: obj({ kinds: arr(str()), tasks: int() }),
		write: method(str()),
	},
});

const facet = defineFacet((host) => {
	host.serve(Chat, (_, self) => {
		const harness = self.open(
			async (open) => {
				const opened = await Harness.open(
					await StoreStorage.open(store, Chat.name, open),
					{ models: createModels(), registry: createRegistry() },
					open,
				);
				await opened.root(open);
				return opened;
			},
			(h, _reason, close) => h.close(close),
		);
		// 1. Follow two of Durable's views; they attach once the natives opened.
		const view = self.follow((observer, ctx) =>
			harness.value.observeConversation(ROOT_CONVERSATION_ID, observer, ctx, { min: 50 }),
		);
		const graph = self.follow((observer, ctx) => harness.value.observeTaskGraph(observer, ctx));
		// 2. A derive over both: one compute per Durable commit.
		const summary = self.derive([view, graph], ([v, g]) => ({
			kinds: v.entries.map((entry) => entry.kind),
			tasks: Object.keys(g.tasks).length,
		}));
		return {
			summary,
			write: async (kind, ctx) => {
				const root = await harness.value.conversation(ROOT_CONVERSATION_ID, ctx);
				await root!.submit({ type: "write", entry: { kind } }, ctx);
				return null;
			},
		};
	});
});

const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
const host = createHost({ store, onError: (error) => console.log("onError", error.kind) });
await host.load([{ name: "@example/core", facet }], context);
const chat = await host.get(Chat, {}, context);

// 3. Watch the member: one frame per Durable commit, with its ops.
const watch = await chat.summary.watch(context);
watch.start(async (call) => {
	if (call.kind === "value") console.log("frame:", call.value.kinds, JSON.stringify(call.ops));
});
await chat.write("example.first", context);
await chat.write("example.second", context);
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("member value:", chat.summary.value);

// 4. Closing the host detaches the observers; the store is the app's.
await watch.stop();
await host.close(context);
await store.close(context);
