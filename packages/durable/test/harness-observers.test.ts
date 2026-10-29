// Tests for the Harness's synchronous observers (`observeConversation()`, `observeTaskGraph()`, `observeDoc()` of a task
// document) and for task document watches, which end with their task.
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { WatchCall } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
	type ConversationView,
	defineDoc,
	defineExtension,
	defineTask,
	type Observer,
	type TaskGraph,
	type TaskId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { SessionImpl } from "../src/session/session.ts";
import { ControlledStorage, context, flush, onValue } from "./session-support.ts";
import { completed, deferred, eventually, openTasks, settled } from "./task-support.ts";

type Step = { phase: "run" };

const Progress = defineDoc<{ lines: string[] }>({
	checkpointWhen: () => false,
	kind: "test.observers.progress",
	version: 1,
	scope: "task",
	initial: () => ({ lines: [] }),
});

/** A task that writes its progress document, waits for `gate`, then completes, which retires the document. */
function writer(name: string, gate: Promise<void>, written: () => void) {
	return defineTask<null, Step, null>({
		name,
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, ctx) => {
				await runtime.commit(async (tx) => {
					(await tx.doc(Progress, task.id)).lines.push("started");
				}, ctx);
				written();
				await gate;
				await runtime.commit(() => completed(null), ctx);
			},
		},
		abort: async () => {},
	});
}

type WatchValue<T> = Extract<WatchCall<T>, { readonly kind: "value" }>;

/** An observer recording each call and whether it ran inside the storage's `adopt`. */
function recorder<T>(storage: ControlledStorage) {
	const calls: Array<{ readonly advance: WatchValue<T>; readonly adopting: boolean } | { readonly end: unknown }> = [];
	const observer: Observer<T> = {
		advance: (call) => {
			// Durable never sends a failure call.
			if (call.kind !== "value") throw new Error("Unexpected failure call");
			calls.push({ advance: call, adopting: storage.adopting });
		},
		end: (end) => {
			calls.push({ end });
		},
	};
	return { calls, observer };
}

/** A Harness with a writer task started in the root conversation and its progress document written. */
async function openWriter() {
	const storage = new ControlledStorage();
	const gate = deferred();
	const written = deferred();
	const Writer = writer("test.observers.writer", gate.promise, written.resolve);
	const opened = await openTasks(storage, [Writer]);
	const root = await opened.harness.root(context);
	const id: TaskId = await root.commit(
		(tx) => tx.createTask(Writer, null, { ownership: { kind: "conversation" } }),
		context,
	);
	opened.harness.resume();
	await written.promise;
	return { ...opened, storage, root, id, finish: gate.resolve };
}

const collect = (() => {
	setFlagsFromString("--expose-gc");
	const gc = runInNewContext("gc") as () => void;
	return async (): Promise<void> => {
		for (let round = 0; round < 5; round++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			gc();
		}
	};
})();

describe("observeConversation and observeTaskGraph", () => {
	it("start at the current value and advance inside adopt with the same change a watch gets", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, []);
		const root = await harness.root(context);
		const view = recorder<ConversationView>(storage);
		const viewObservation = await harness.observeConversation(root.id, view.observer, context);
		const graph = recorder<TaskGraph>(storage);
		const graphObservation = await harness.observeTaskGraph(graph.observer, context);
		expect(viewObservation.value.conversation.id).toBe(root.id);
		expect(graphObservation.value).toEqual({ tasks: {} });
		const watch = await root.watch(context);
		const watched: WatchCall<ConversationView>[] = [];
		watch.start(async (change) => {
			watched.push(change);
		});
		const entry = await root.commit((tx) => tx.appendEntry(root.id, { kind: "note", data: {} }), context);
		expect(view.calls).toHaveLength(1);
		const [call] = view.calls as [{ advance: WatchValue<ConversationView>; adopting: boolean }];
		expect(call.adopting).toBe(true);
		expect(call.advance.retired).toBe(false);
		expect(call.advance.value.entries.at(-1)?.id).toBe(entry.id);
		await flush();
		expect(watched).toEqual([call.advance]);
		// No task changed: the graph got nothing.
		expect(graph.calls).toEqual([]);
		viewObservation.detach();
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "note", data: {} }), context);
		expect(view.calls).toHaveLength(1);
		await watch.stop();
		const graphWatch = await harness.watchTaskGraph(context);
		await harness.close(context);
		// S1: a Session close fails an observer (it may follow the next Session); a watch ends `ended`.
		expect(graph.calls).toEqual([{ end: { kind: "failed", error: new Error("session closed") } }]);
		expect(await graphWatch.closed).toEqual({ kind: "ended" });
	});

	it("end with the error that failed the Harness", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, []);
		const root = await harness.root(context);
		const graph = recorder<TaskGraph>(storage);
		await harness.observeTaskGraph(graph.observer, context);
		const failure = new Error("disk gone");
		storage.failNextCommit(failure);
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note", data: {} }), context)).rejects.toThrow(
			"disk gone",
		);
		await harness.closed;
		expect(graph.calls).toEqual([{ end: { kind: "failed", error: failure } }]);
	});

	it("report a throwing observer, detach it and end it with the error, and keep the view going", async () => {
		const storage = new ControlledStorage();
		const { harness, reports, infos } = await openTasks(storage, []);
		const root = await harness.root(context);
		const bug = new Error("observer bug");
		const ends: unknown[] = [];
		await harness.observeConversation(
			root.id,
			{
				advance: () => {
					throw bug;
				},
				end: (end) => ends.push(end),
			},
			context,
		);
		const healthy = recorder<ConversationView>(storage);
		await harness.observeConversation(root.id, healthy.observer, context);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "note", data: {} }), context);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "note", data: {} }), context);
		expect(reports).toEqual([bug]);
		expect(infos).toEqual([{ kind: "listener_error" }]);
		expect(ends).toEqual([{ kind: "listener_error", error: bug }]);
		expect(healthy.calls).toHaveLength(2);
		await harness.close(context);
		expect(ends).toHaveLength(1);
		expect(await harness.closed).toEqual({ kind: "closed" });
	});

	it("reject, never throw, on a closed Harness", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, []);
		const root = await harness.root(context);
		await harness.close(context);
		const view = harness.observeConversation(root.id, recorder<ConversationView>(storage).observer, context);
		const graph = harness.observeTaskGraph(recorder<TaskGraph>(storage).observer, context);
		await expect(view).rejects.toThrow("Session is closed");
		await expect(graph).rejects.toThrow("Session is closed");
	});

	it("reject an attachment cancelled while it waits on the line, and attach nothing", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, []);
		const root = await harness.root(context);
		const view = recorder<ConversationView>(storage);
		const graph = recorder<TaskGraph>(storage);
		// A commit holds the line, so both attachments wait behind it.
		const held = storage.holdCommits();
		const committing = root.commit((tx) => tx.appendEntry(root.id, { kind: "note", data: {} }), context);
		await held.entered;
		const controller = new AbortController();
		const cancelled = withAbortSignal(controller.signal, context);
		const attachingView = harness.observeConversation(root.id, view.observer, cancelled);
		const attachingGraph = harness.observeTaskGraph(graph.observer, cancelled);
		controller.abort(new Error("gone"));
		held.release();
		await committing;
		await expect(attachingView).rejects.toThrow("gone");
		await expect(attachingGraph).rejects.toThrow("gone");
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "note", data: {} }), context);
		await harness.close(context);
		expect(view.calls).toEqual([]);
		expect(graph.calls).toEqual([]);
	});

	it("advance a graph observer with a blocked refresh, outside any commit", async () => {
		const Missing = defineTask<null, Step, null>({
			name: "test.observers.missing",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: { run: (_task, runtime, ctx) => runtime.commit(() => completed(null), ctx) },
			abort: async () => {},
		});
		const storage = new ControlledStorage();
		const { harness, registry } = await openTasks(storage, []);
		const graph = recorder<TaskGraph>(storage);
		const observation = await harness.observeTaskGraph(graph.observer, context);
		const root = await harness.root(context);
		// Scheduling is not resumed: the task stays pending, blocked while its definition is missing.
		const id = await root.commit(
			(tx) => tx.createTask(Missing, null, { ownership: { kind: "conversation" } }),
			context,
		);
		const key = String(id);
		expect(graph.calls).toEqual([
			{
				advance: {
					kind: "value",
					value: { tasks: { [key]: expect.objectContaining({ blocked: "missing_task" }) } },
					ops: [["s", ["tasks", key], expect.objectContaining({ blocked: "missing_task" })]],
					retired: false,
				},
				adopting: true,
			},
		]);
		registry.install(defineExtension({ name: "late", tasks: [Missing] }));
		await eventually(() => graph.calls.length === 2);
		// The registry change re-derives the reason on the line, with no commit and outside the storage's `adopt`.
		expect(graph.calls[1]).toEqual({
			advance: { kind: "value", value: expect.anything(), ops: [["d", ["tasks", key, "blocked"]]], retired: false },
			adopting: false,
		});
		expect((graph.calls[1] as { advance: WatchValue<TaskGraph> }).advance.value.tasks[key]?.blocked).toBeUndefined();
		harness.resume();
		await harness.waitForTask(id, context);
		observation.detach();
		await harness.close(context);
	});

	it("keep no detached observer alive", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, []);
		const root = await harness.root(context);
		/** Attach observers only the Harness references; `detach` says whether to detach them before returning. */
		const attach = async (detach: boolean) => {
			const view: Observer<ConversationView> = { advance: () => {}, end: () => {} };
			const graph: Observer<TaskGraph> = { advance: () => {}, end: () => {} };
			const observations = [
				await harness.observeConversation(root.id, view, context),
				await harness.observeTaskGraph(graph, context),
			];
			if (detach) for (const observation of observations) observation.detach();
			return { observations, view: new WeakRef(view), graph: new WeakRef(graph) };
		};
		// Control: attached observers stay, so the collection below is real.
		const attached = await attach(false);
		await collect();
		expect(attached.view.deref()).toBeDefined();
		expect(attached.graph.deref()).toBeDefined();
		for (const observation of attached.observations) observation.detach();

		const detached = await attach(true);
		await collect();
		expect(detached.view.deref()).toBeUndefined();
		expect(detached.graph.deref()).toBeUndefined();
		await harness.close(context);
	});
});

describe("task documents", () => {
	it("a watch delivers the retirement of the commit that ends its task, then ends `ended`", async () => {
		const { harness, id, finish } = await openWriter();
		const watch = (await harness.watchDoc(Progress, id, context))!;
		expect(watch.value).toEqual({ lines: ["started"] });
		const changes: WatchCall<Readonly<{ lines: string[] }>>[] = [];
		watch.start(async (change) => {
			changes.push(change);
		});
		finish();
		await harness.waitForTask(id, context);
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(changes).toEqual([{ kind: "value", value: { lines: ["started"] }, ops: [], retired: true }]);
		expect((changes[0] as { value: unknown }).value).toBe(watch.value);
		// The task is terminal: its address is absent for good.
		expect(await harness.watchDoc(Progress, id, context)).toBeUndefined();
		await harness.close(context);
	});

	it("an observer gets the retirement, then its end, inside the adopt of the commit that ends the task", async () => {
		const { harness, storage, id, finish } = await openWriter();
		const progress = recorder<Readonly<{ lines: string[] }>>(storage);
		let endedAdopting: boolean | undefined;
		const observer: Observer<Readonly<{ lines: string[] }>> = {
			advance: progress.observer.advance,
			end: (end) => {
				endedAdopting = storage.adopting;
				progress.observer.end(end);
			},
		};
		await harness.observeDoc(Progress, id, observer, context);
		finish();
		await harness.waitForTask(id, context);
		expect(progress.calls).toEqual([
			{ advance: { kind: "value", value: { lines: ["started"] }, ops: [], retired: true }, adopting: true },
			{ end: { kind: "ended" } },
		]);
		expect(endedAdopting).toBe(true);
		await harness.close(context);
		expect(progress.calls).toHaveLength(2);
	});

	it("keeps no task document watch alive once its task ended", async () => {
		const { harness, id, finish } = await openWriter();
		/** A started watch of the task's document, which only the Harness references. */
		const acquire = async (): Promise<WeakRef<object>> => {
			const watch = (await harness.watchDoc(Progress, id, context))!;
			watch.start(async () => {});
			return new WeakRef(watch);
		};
		const watch = await acquire();
		// Control: the watch stays while its task runs, so the collection below is real.
		await collect();
		expect(watch.deref()).toBeDefined();
		finish();
		await harness.waitForTask(id, context);
		await collect();
		expect(watch.deref()).toBeUndefined();
		// The Harness is the Session kernel; nothing stays pinned for the ended watch.
		expect((harness as unknown as SessionImpl).documentCacheSizes.attached).toBe(0);
		await harness.close(context);
	});

	it("a watch never started when its task ends still ends with the Harness's close, keeping nothing of it", async () => {
		/** Acquire a task document's watch, never start it, end its task, and close the Harness. */
		const acquire = async () => {
			const { harness, id, finish } = await openWriter();
			const watch = (await harness.watchDoc(Progress, id, context))!;
			finish();
			await harness.waitForTask(id, context);
			// Its retirement is pending until a start that never comes: the watch is open.
			await flush();
			expect(await settled(watch.closed)).toBe(false);
			await harness.close(context);
			return { watch, harness: new WeakRef(harness) };
		};
		const { watch, harness } = await acquire();
		// Closed at the Harness's close, the pending retirement dropped, as for every watch.
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(() => watch.start(async () => {})).toThrow("Watch is stopped");
		await collect();
		expect(harness.deref()).toBeUndefined();
	});

	it("a watch never started when its task ends fails with the Harness", async () => {
		const { harness, storage, root, id, finish } = await openWriter();
		const watch = (await harness.watchDoc(Progress, id, context))!;
		finish();
		await harness.waitForTask(id, context);
		const failure = new Error("disk gone");
		storage.failNextCommit(failure);
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note", data: {} }), context)).rejects.toThrow(
			"disk gone",
		);
		expect(await watch.closed).toEqual({ kind: "failed", error: failure });
	});

	it("a watch busy in an earlier call when its task ends fails with the Harness before its retirement call", async () => {
		const { harness, storage, root, id, finish } = await openWriter();
		const watch = (await harness.watchDoc(Progress, id, context))!;
		const entered = deferred();
		const release = deferred();
		const values: unknown[] = [];
		watch.start(
			onValue(async ({ value }) => {
				values.push(value);
				entered.resolve();
				await release.promise;
			}),
		);
		await harness.commit(async (tx) => {
			(await tx.doc(Progress, id)).lines.push("more");
		}, context);
		await entered.promise;
		// The task ends while the listener is busy: its retirement waits behind the running call.
		finish();
		await harness.waitForTask(id, context);
		const failure = new Error("disk gone");
		storage.failNextCommit(failure);
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "note", data: {} }), context)).rejects.toThrow(
			"disk gone",
		);
		expect(await watch.closed).toEqual({ kind: "failed", error: failure });
		release.resolve();
		await flush();
		expect(values).toEqual([{ lines: ["started", "more"] }]);
	});

	it("a watch whose retirement call runs when its task ends ends only after that call returns", async () => {
		const { harness, id, finish } = await openWriter();
		const watch = (await harness.watchDoc(Progress, id, context))!;
		const entered = deferred();
		const release = deferred();
		let returned = false;
		watch.start(async () => {
			entered.resolve();
			await release.promise;
			returned = true;
		});
		// An explicit retirement first: its call runs while the task ends, and nothing more is pending.
		await harness.commit((tx) => tx.retireDoc(Progress, id), context);
		await entered.promise;
		finish();
		await harness.waitForTask(id, context);
		await flush();
		expect(await settled(watch.closed)).toBe(false);
		release.resolve();
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(returned).toBe(true);
		await harness.close(context);
	});

	it("hands listeners changes that keep nothing of the Harness", async () => {
		/** Watch a task document until its task ends, keeping every change, then close the Harness. */
		const acquire = async () => {
			const { harness, id, finish } = await openWriter();
			const watch = (await harness.watchDoc(Progress, id, context))!;
			const changes: WatchCall<Readonly<{ lines: string[] }>>[] = [];
			watch.start(async (change) => {
				changes.push(change);
			});
			await harness.commit(async (tx) => {
				(await tx.doc(Progress, id)).lines.push("more");
			}, context);
			await flush();
			finish();
			await harness.waitForTask(id, context);
			expect(await watch.closed).toEqual({ kind: "ended" });
			await harness.close(context);
			return { changes, harness: new WeakRef(harness) };
		};
		const { changes, harness } = await acquire();
		expect(changes).toHaveLength(2);
		for (const change of changes) {
			expect(Object.keys(change)).toEqual(["kind", "value", "ops", "retired"]);
			expect(structuredClone(change)).toEqual(change);
		}
		await collect();
		expect(harness.deref()).toBeUndefined();
	});
});
