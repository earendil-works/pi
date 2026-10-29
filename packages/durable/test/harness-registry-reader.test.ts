import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	arr,
	createHost,
	defineFacet,
	defineRegistry,
	type FacetHost,
	local,
	method,
	type Native,
	type RegistryTable,
	str,
} from "@earendil-works/chord/next";
import { createModels } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";
import {
	createRegistry,
	defineExtension,
	defineTask,
	type Extension,
	Harness,
	MemoryStorage,
	type RegistrySnapshot,
	ROOT_CONVERSATION_ID,
	registryReader,
} from "../src/index.ts";

/** p3's pattern: the extensions registry composes Durable's snapshot, leaving out an extension Durable refuses. */
const Extensions = defineRegistry<Extension, RegistrySnapshot>("app.harness.extensions", { version: 1 });

function compose(table: RegistryTable<Extension>, report: (conflict: { message: string; plugins: string[] }) => void) {
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

const Done = defineTask<undefined, { phase: "run" }, null>({
	name: "app.done",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (_task, runtime, taskContext) => {
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
				taskContext,
			);
		},
	},
	abort: async () => {},
});

/** A host-lifetime object contributing an extension it replaces with `install` (one with the task `app.done`). */
const Plugin = local("app.plugin", { version: 1, params: {}, members: { install: method() } });

function serve(host: FacetHost): void {
	host.serve(Extensions, { compose: (table, { report }) => compose(table, report) });
	host.serve(Plugin, (_, self) => {
		const extension = self.writable<Extension>(defineExtension({ name: "app.plugin" }));
		self.contribute(Extensions, extension);
		return {
			install: async () => {
				extension.set(defineExtension({ name: "app.plugin", tasks: [Done] }));
				return null;
			},
		};
	});
}

describe("registryReader", () => {
	it("reads the composed snapshot; a listener is called synchronously, inside the batch that composed", async () => {
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/core", facet: defineFacet(serve) }], context);
		const value = await host.registry(Extensions, context);
		const reader = registryReader(value, context);
		expect(reader.snapshot().extension("app.plugin")?.tasks).toBeUndefined();
		const calls: string[] = [];
		const unsubscribe = reader.subscribe(() => {
			// Inside Chord's batch: a Chord call here is refused, so a listener only wakes its scheduler.
			try {
				value.observe({ advance: () => {}, end: () => {} }, context);
				calls.push("outside");
			} catch (error) {
				calls.push((error as { reason?: string }).reason ?? "other");
			}
		});
		const plugin = await host.get(Plugin, {}, context);
		await plugin.install(context);
		expect(calls).toEqual(["reentrant"]);
		expect(reader.snapshot().task("app.done")).toBe(Done);
		unsubscribe();
		await host.close(context);
	});

	it("wakes a Harness's scheduler: a task blocked on its missing definition runs once a contribution brings it", async () => {
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/core", facet: defineFacet(serve) }], context);
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models: createModels(), registry: registryReader(await host.registry(Extensions, context), context) },
			context,
		);
		harness.resume();
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(Done, undefined, { ownership: { kind: "conversation" } }),
			context,
		);
		const done = harness.waitForTask(id, context);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await (await host.get(Plugin, {}, context)).install(context);
		expect((await done).state.outcome).toEqual({ status: "completed", result: null });
		await harness.close(context);
		await host.close(context);
	});
});

/** p3's pattern for Durable's views from other objects: the object that opens Durable contributes its Harness. */
const Harnesses = defineRegistry<Native<Harness>, Harness | undefined>("app.harnesses", { version: 1 });

/** Opens a Harness (a new one per attempt), contributes it, and follows its task graph: its Session closing fails it. */
const Durable = local("app.durable", { version: 1, params: {}, members: { close: method(), write: method(str()) } });

/** Follows the root conversation's entry kinds through the contributed Harness, from another object. */
const Viewer = local("app.viewer", { version: 1, params: {}, members: { kinds: arr(str()) } });

function serveViews(host: FacetHost): void {
	host.serve(Harnesses, { compose: (table) => table.at(-1)?.value.value });
	host.serve(Durable, (_, self) => {
		const harness = self.open(
			async (open) => {
				const opened = await Harness.open(
					new MemoryStorage(),
					{ models: createModels(), registry: createRegistry() },
					open,
				);
				await opened.root(open);
				return opened;
			},
			(h, _reason, close) => h.close(close),
		);
		self.contribute(Harnesses, harness);
		self.follow((observer, ctx) => harness.value.observeTaskGraph(observer, ctx));
		return {
			close: async (ctx) => {
				await harness.value.close(ctx);
				return null;
			},
			write: async (kind, ctx) => {
				const root = await harness.value.conversation(ROOT_CONVERSATION_ID, ctx);
				await root!.submit({ type: "write", entry: { kind } }, ctx);
				return null;
			},
		};
	});
	host.serve(Viewer, (_, self) => {
		const harness = self.registry(Harnesses);
		self.retryOn(harness);
		const view = self.follow(async (observer, ctx) =>
			harness.value === undefined
				? undefined
				: harness.value.observeConversation(ROOT_CONVERSATION_ID, observer, ctx),
		);
		return { kinds: self.derive([view], ([v]) => v.entries.map((entry) => entry.kind)) };
	});
}

describe("Durable's views from other objects (slice 8 §5, S1)", () => {
	it("a follower of a contributed Harness fails when that Harness's Session closes, and follows the next one", async () => {
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/core", facet: defineFacet(serveViews) }], context);
		const durable = host.hold(Durable, {}, context);
		const viewer = host.hold(Viewer, {}, context);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await durable.write("app.first", context);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(viewer.kinds.value).toContain("app.first");
		// The Session closes: both followers fail `transient` (S1); a retry opens the next Harness, whose contribution
		// wakes the viewer (`retryOn`), which follows it.
		// The call is cut off by its object's failure: the Session's close fails the object that opened it.
		await expect(durable.close(context)).rejects.toThrow("session closed");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(viewer.state.value).toMatchObject({ kind: "failed", cause: { kind: "transient" } });
		durable.retry();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(viewer.state.value).toEqual({ kind: "live" });
		expect(viewer.kinds.value).not.toContain("app.first");
		await durable.write("app.second", context);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(viewer.kinds.value).toContain("app.second");
		await host.close(context);
	});
});
