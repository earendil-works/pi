// A Durable harness in Chord objects, p3's pattern (Chord v2 slice 8): the object that opens Durable on the host's store
// takes its extensions from a Chord registry (`registryReader`), so any plugin extends the harness by contributing an
// extension; and it contributes its Harness to a second registry, through which another object follows its views
// (`self.follow`). When that Harness's Session closes, the follower fails and follows the next Harness, woken by its
// contribution (`self.retryOn`).
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/37-harness-registry.ts

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	arr,
	createHost,
	defineFacet,
	defineRegistry,
	local,
	method,
	type Native,
	openStore,
	type RegistryTable,
	sqliteBackend,
	str,
} from "@earendil-works/chord/next";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTask,
	type Extension,
	Harness,
	type RegistrySnapshot,
	ROOT_CONVERSATION_ID,
	registryReader,
} from "../../src/index.ts";
import { StoreStorage } from "../../src/storage/store/index.ts";

const context = BACKGROUND_CONTEXT;

// 1. The core's registries: extensions in, Durable's registry snapshot out; and the Harness, for other objects.
const Extensions = defineRegistry<Extension, RegistrySnapshot>("example.extensions", { version: 1 });
const Harnesses = defineRegistry<Native<Harness>, Harness | undefined>("example.harnesses", { version: 1 });

/** Builds Durable's snapshot without throwing: an extension Durable refuses (a task name taken) is reported, left out. */
function snapshotOf(
	table: RegistryTable<Extension>,
	report: (conflict: { message: string; plugins: string[] }) => void,
) {
	const registry = createRegistry();
	for (const { value, plugin } of table) {
		try {
			registry.install(value);
		} catch (error) {
			report({ message: (error as Error).message, plugins: [plugin] });
		}
	}
	return registry.snapshot();
}

const Core = local("example.harness", {
	version: 1,
	params: {},
	members: { greet: method(undefined, str()), close: method() },
});
const Transcript = local("example.transcript", { version: 1, params: {}, members: { kinds: arr(str()) } });

// 2. The core facet: the harness object opens Durable on the store with its extensions read from the registry.
const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
const core = defineFacet((host) => {
	host.serve(Extensions, { compose: (table, { report }) => snapshotOf(table, report) });
	host.serve(Harnesses, { compose: (table) => table.at(-1)?.value.value });
	host.serve(Core, (_, self) => {
		// A declared dependency: the object activates (and opens Durable) once the registry has a value.
		const extensions = self.registry(Extensions);
		const harness = self.open(
			async (open) => {
				const opened = await Harness.open(
					await StoreStorage.open(store, Core.name, open),
					{ models: createModels(), registry: registryReader(extensions, open) },
					open,
				);
				await opened.root(open);
				return opened;
			},
			(h, _reason, close) => h.close(close),
		);
		self.contribute(Harnesses, harness);
		// Following its own task graph, the object fails with its Session (S1), and its retry opens the next Harness.
		self.follow((observer, ctx) => harness.value.observeTaskGraph(observer, ctx));
		return {
			greet: async (ctx) => {
				// The composed snapshot, read at use: is the task's extension installed?
				if (extensions.value.task(Greet.definition.name) === undefined) return "no greeter installed";
				const root = await harness.value.conversation(ROOT_CONVERSATION_ID, ctx);
				const id = await root!.commit(
					(tx) => tx.createTask(Greet, undefined, { ownership: { kind: "conversation" } }),
					ctx,
				);
				harness.value.resume();
				return JSON.stringify((await harness.value.waitForTask(id, ctx)).state.outcome);
			},
			close: async (ctx) => {
				await harness.value.close(ctx);
				return null;
			},
		};
	});
	// 3. Another object follows the harness's conversation view through the registry.
	host.serve(Transcript, (_, self) => {
		const harness = self.registry(Harnesses);
		self.retryOn(harness);
		const view = self.follow(async (observer, ctx) =>
			harness.value?.observeConversation(ROOT_CONVERSATION_ID, observer, ctx),
		);
		return { kinds: self.derive([view], ([v]) => v.entries.map((entry) => entry.kind)) };
	});
});

// 4. Two plugins contribute extensions with the same task name, which Durable refuses: the first by plugin name
//    (copycat) is installed, the other reported.
const Greet = defineTask<undefined, { phase: "run" }, string>({
	name: "example.greet",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (_task, runtime, taskContext) => {
			await runtime.commit(async (tx) => {
				await tx.appendEntry(ROOT_CONVERSATION_ID, { kind: "example.greeted", data: {} });
				return { status: "terminal", outcome: { status: "completed", result: "hello" } };
			}, taskContext);
		},
	},
	abort: async () => {},
});
const greeter = defineFacet((_, self) =>
	self.contribute(Extensions, defineExtension({ name: "greeter", tasks: [Greet] })),
);
const copycat = defineFacet((_, self) =>
	self.contribute(Extensions, defineExtension({ name: "copycat", tasks: [Greet] })),
);

const host = createHost({
	store,
	onError: (error) => console.log("onError:", error.kind, error.kind === "registry_conflict" ? error.message : ""),
});
await host.load(
	[
		{ name: "@example/core", facet: core },
		{ name: "@example/greeter", facet: greeter },
		{ name: "@example/copycat", facet: copycat },
	],
	context,
);

// 5. The task comes from a contributed extension; the transcript object sees its entry. (It failed once at start, before
//    the harness object contributed its Harness: `activation_failed`, then the contribution woke it.)
const harness = host.hold(Core, {}, context);
const transcript = host.hold(Transcript, {}, context);
console.log("greet:", await harness.greet(context));
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("transcript:", transcript.kinds.value);

// 6. The Session closes: both objects fail; a retry of the harness object opens the next Harness (on the same store:
//    the transcript is still there), whose contribution wakes the follower.
await harness.close(context).catch((error: Error) => console.log("close:", error.message));
await new Promise((resolve) => setTimeout(resolve, 10));
console.log("transcript after the close:", transcript.state.value.kind);
harness.retry();
await new Promise((resolve) => setTimeout(resolve, 50));
console.log("transcript after the retry:", transcript.state.value.kind, transcript.kinds.value);

await host.close(context);
await store.close(context);
