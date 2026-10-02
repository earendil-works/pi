import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import {
	type ConversationId,
	defineTask,
	type EntryId,
	MemoryStorage,
	type TaskGraph,
	type TaskId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { ControlledStorage, context, flush } from "./session-support.ts";
import { aborted, completed, deferred, eventually, openTasks } from "./task-support.ts";

type ParentState = { phase: "spawn" } | { phase: "join"; child: TaskId } | { phase: "finish" };

/**
 * A parent that creates a child task and a conversation it owns, waits for the child, creates a second child, and
 * completes while that child is still live, so its outcome is held as `completing`.
 */
function family(gates: { readonly child: Promise<void>; readonly late: Promise<void> }) {
	const Child = defineTask<{ late: boolean }, { phase: "work" }, null>({
		name: "test.graph-child",
		version: 1,
		initial: () => ({ phase: "work" }),
		phases: {
			work: async (task, runtime, ctx) => {
				await (task.input.late ? gates.late : gates.child);
				await runtime.commit(() => completed(null), ctx);
			},
		},
		abort: async () => {},
	});
	const Parent = defineTask<null, ParentState, null>({
		name: "test.graph-parent",
		version: 1,
		initial: () => ({ phase: "spawn" }),
		phases: {
			spawn: async (task, runtime, ctx) => {
				const ownership = { kind: "task", taskId: task.id } as const;
				// Two conversations in a commit that leaves the parent's record unchanged.
				await runtime.commit(async (tx) => {
					await tx.createConversation({ ownership });
					await tx.createConversation({ ownership });
					return undefined;
				}, ctx);
				await runtime.commit(async (tx) => {
					const child = await tx.createTask(Child, { late: false }, { ownership });
					return { status: "waiting", checkpoint: { phase: "join", child }, on: [child], policy: "allSettled" };
				}, ctx);
			},
			join: async (task, runtime, ctx) => {
				await runtime.commit(async (tx) => {
					await tx.createTask(Child, { late: true }, { ownership: { kind: "task", taskId: task.id } });
					return { status: "running", checkpoint: { phase: "finish" } };
				}, ctx);
			},
			finish: async (_task, runtime, ctx) => {
				await runtime.commit(() => completed(null), ctx);
			},
		},
		abort: async () => {},
	});
	return { Parent, Child };
}

function gatesNever() {
	const never = new Promise<void>(() => {});
	return { child: never, late: never };
}

/** Node states by task kind, for compact assertions. */
function statuses(graph: TaskGraph): Record<string, string> {
	return Object.fromEntries(
		Object.values(graph.tasks).map((node) => [`${node.kind}#${node.id}`, node.state.status] as const),
	);
}

describe("task graph view", () => {
	it("follows every live task through its statuses, owner edges, and owned conversations", async () => {
		const child = deferred();
		const late = deferred();
		const { Parent, Child } = family({ child: child.promise, late: late.promise });
		const { harness } = await openTasks(new MemoryStorage(), [Parent, Child]);
		const root = await harness.root(context);
		const seen: TaskGraph[] = [];
		const observe = async () => {
			const opened = await harness.taskGraph(context);
			opened.subscribe((value, _context, delivery) => {
				if (delivery.kind === "update") seen.push(value);
			});
			return opened;
		};
		let graph = await observe();
		expect(graph.value).toEqual({ tasks: {} });
		/** The advanced value equals a fresh build from Storage once the last observer left. */
		const rebuild = async () => {
			const advanced = graph.value;
			graph.dispose();
			graph = await observe();
			expect(graph.value).not.toBe(advanced);
			expect(graph.value).toEqual(advanced);
		};

		const parent = await root.commit(
			(tx) => tx.createTask(Parent, null, { ownership: { kind: "conversation" } }),
			context,
		);
		await flush();
		expect(graph.value.tasks[String(parent)]).toEqual({
			id: parent,
			kind: "test.graph-parent",
			conversationId: root.id,
			background: false,
			abortRequested: false,
			state: { status: "pending", phase: "spawn" },
			conversations: [],
		});

		harness.resume();
		await eventually(
			() =>
				Object.keys(graph.value.tasks).length === 2 &&
				statuses(graph.value)[`test.graph-child#${childId()}`] === "running",
		);
		function childId(): string {
			return (
				Object.values(graph.value.tasks)
					.find((node) => node.kind === "test.graph-child")
					?.id.toString() ?? ""
			);
		}
		const first = Number(childId()) as TaskId;
		const parentNode = graph.value.tasks[String(parent)]!;
		expect(parentNode.state).toEqual({ status: "waiting", phase: "join", on: [first], policy: "allSettled" });
		expect(parentNode.conversations).toHaveLength(2);
		expect([...parentNode.conversations].sort((a, b) => a - b)).toEqual(parentNode.conversations);
		const owned = parentNode.conversations[0]!;
		expect(graph.value.tasks[String(first)]).toMatchObject({ owner: parent, conversationId: root.id });
		expect((await harness.conversation(owned, context)) !== undefined).toBe(true);
		await rebuild();

		child.resolve();
		// The parent completes while the late child lives: its outcome is held.
		await eventually(() => graph.value.tasks[String(parent)]?.state.status === "completing");
		expect(graph.value.tasks[String(parent)]!.state).toEqual({ status: "completing", outcome: "completed" });
		expect(graph.value.tasks[String(first)]).toBeUndefined();
		// Owned conversations stay listed while the owner lives.
		expect(graph.value.tasks[String(parent)]!.conversations).toEqual(parentNode.conversations);
		await rebuild();

		late.resolve();
		await harness.waitForTask(parent, context);
		await flush();
		expect(graph.value).toEqual({ tasks: {} });
		// Every revision is one commit that changed a node; none repeats its predecessor.
		for (let index = 1; index < seen.length; index++) expect(seen[index]).not.toEqual(seen[index - 1]);
		// The commit that created the two conversations published one revision setting them.
		expect(seen.some((value) => value.tasks[String(parent)]?.conversations.length === 2)).toBe(true);
		graph.dispose();
		await harness.close(context);
	});

	it("builds from committed tasks, shows surviving tasks as pending after reopen, and marks aborts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-graph-"));
		const path = join(directory, "session.sqlite");
		const gate = deferred();
		const Work = defineTask<null, { phase: "work" }, null>({
			name: "test.graph-work",
			version: 1,
			initial: () => ({ phase: "work" }),
			phases: {
				work: async (_task, runtime, ctx) => {
					await Promise.race([gate.promise, aborted(runtime.signal)]);
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "test" } }), ctx);
			},
		});
		const first = await openTasks(await openNodeSqliteStorage(path), [Work]);
		const firstRoot = await first.harness.root(context);
		const [foreground, background, owned] = await firstRoot.commit(async (tx) => {
			const foreground = await tx.createTask(Work, null, { ownership: { kind: "conversation" } });
			const background = await tx.createTask(Work, null, { ownership: { kind: "conversation" }, background: true });
			const owned = await tx.createConversation({ ownership: { kind: "task", taskId: foreground } });
			return [foreground, background, owned.id] as const;
		}, context);
		first.harness.resume();
		await eventually(async () =>
			(await first.harness.inspect(context)).tasks.every((task) => task.state.kind === "running"),
		);
		const running = await first.harness.taskGraph(context);
		expect(statuses(running.value)).toEqual({
			[`test.graph-work#${foreground}`]: "running",
			[`test.graph-work#${background}`]: "running",
		});
		await first.harness.close(context);

		// Acquired after reopen: built from the committed records and owner edges; open reconciled running to pending.
		const { harness } = await openTasks(await openNodeSqliteStorage(path), [Work]);
		const watch = await harness.watchTaskGraph(context);
		expect(statuses(watch.value)).toEqual({
			[`test.graph-work#${foreground}`]: "pending",
			[`test.graph-work#${background}`]: "pending",
		});
		expect(watch.value.tasks[String(foreground)]!.conversations).toEqual([owned as ConversationId]);
		expect(watch.value.tasks[String(background)]!.background).toBe(true);

		// Exact frames: replaying their operations from the acquisition revision gives each delivered value.
		let replica: JsonValue = watch.value as unknown as JsonValue;
		const frames: (readonly Op[])[] = [];
		watch.start(async (value, ops) => {
			replica = applyImmutable(replica, ops);
			expect(replica).toEqual(value);
			frames.push(ops);
		});
		harness.resume();
		await eventually(() => watch.value.tasks[String(background)]?.state.status === "running");
		expect(await harness.abortTask(background, context)).toBe("marked");
		await harness.waitForTask(background, context);
		await flush();
		expect(frames).toContainEqual([
			["s", ["tasks", String(background)], expect.objectContaining({ abortRequested: true })],
		]);
		expect(frames.at(-1)).toEqual([["d", ["tasks", String(background)]]]);
		expect(Object.keys((replica as unknown as TaskGraph).tasks)).toEqual([String(foreground)]);
		await watch.stop();
		gate.resolve();
		await harness.waitForTask(foreground, context);
		await harness.close(context);
		await rm(directory, { recursive: true, force: true });
	});

	it("lists owned conversations in ID order whatever order one commit creates them in", async () => {
		const gate = deferred();
		const created: number[] = [];
		const Spawner = defineTask<{ at: EntryId }, { phase: "spawn" }, null>({
			name: "test.graph-spawner",
			version: 1,
			initial: () => ({ phase: "spawn" }),
			phases: {
				spawn: async (task, runtime, ctx) => {
					await runtime.commit(async (tx) => {
						const ownership = { kind: "task", taskId: task.id } as const;
						const [forked, fresh] = await Promise.all([
							tx.forkConversation(runtime.conversationId, task.input.at, { ownership }),
							tx.createConversation({ ownership }),
						]);
						created.push(forked.id, fresh.id);
						return undefined;
					}, ctx);
					await gate.promise;
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: async () => {},
		});
		const { harness } = await openTasks(new MemoryStorage(), [Spawner]);
		const root = await harness.root(context);
		const graph = await harness.taskGraph(context);
		const id = await root.commit(async (tx) => {
			const entry = await tx.appendEntry(root.id, { kind: "note" });
			return tx.createTask(Spawner, { at: entry.id }, { ownership: { kind: "conversation" } });
		}, context);
		harness.resume();
		await eventually(() => (graph.value.tasks[String(id)]?.conversations.length ?? 0) === 2);
		const advanced = graph.value;
		expect(advanced.tasks[String(id)]!.conversations).toEqual([...created].sort((a, b) => a - b));
		graph.dispose();
		const rebuilt = await harness.taskGraph(context);
		expect(rebuilt.value).toEqual(advanced);
		rebuilt.dispose();
		gate.resolve();
		await harness.waitForTask(id, context);
		await harness.close(context);
	});

	it("registers nothing for an acquisition cancelled while it waits for the line", async () => {
		const storage = new ControlledStorage();
		const { harness } = await openTasks(storage, []);
		const root = await harness.root(context);
		await root.commit(
			(tx) => tx.createTask(family(gatesNever()).Child, { late: false }, { ownership: { kind: "conversation" } }),
			context,
		);
		const held = storage.holdCommits();
		const blocking = harness.commit((tx) => tx.appendEntry(root.id, { kind: "blocker" }).then(() => {}), context);
		await held.entered;
		const controller = new AbortController();
		const cancelled = harness.watchTaskGraph({ ...context, abortSignal: controller.signal });
		controller.abort(new Error("cancelled"));
		held.release();
		await blocking;
		await expect(cancelled).rejects.toThrow("cancelled");
		// No observer kept the mount: each new observer builds a new revision.
		const first = await harness.taskGraph(context);
		const value = first.value;
		first.dispose();
		const second = await harness.taskGraph(context);
		expect(second.value).not.toBe(value);
		expect(second.value).toEqual(value);
		second.dispose();
		await harness.close(context);
	});

	it("publishes no revision for a commit that changes no node, and shares one mount between observers", async () => {
		const gate = deferred();
		const reached = deferred();
		const Memo = defineTask<null, { phase: "work" }, null>({
			name: "test.graph-memo",
			version: 1,
			initial: () => ({ phase: "work" }),
			phases: {
				work: async (_task, runtime, ctx) => {
					await runtime.memo("seen", true, ctx);
					reached.resolve();
					await gate.promise;
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: async () => {},
		});
		const { harness } = await openTasks(new MemoryStorage(), [Memo]);
		const root = await harness.root(context);
		const id = await root.commit((tx) => tx.createTask(Memo, null, { ownership: { kind: "conversation" } }), context);
		const first = await harness.taskGraph(context);
		const second = await harness.taskGraph(context);
		expect(second.value).toBe(first.value);
		const updates: string[] = [];
		first.subscribe((value, _context, delivery) => {
			if (delivery.kind === "update") updates.push(value.tasks[String(id)]?.state.status ?? "gone");
		});
		harness.resume();
		await reached.promise;
		await flush();
		// Reservation changed the node; the memo commit did not.
		expect(updates).toEqual(["running"]);
		gate.resolve();
		await harness.waitForTask(id, context);
		await flush();
		expect(updates).toEqual(["running", "gone"]);
		const last = first.value;
		first.dispose();
		second.dispose();
		// No observer is left, so the mount was dropped: a new observer builds a new revision.
		const rebuilt = await harness.taskGraph(context);
		expect(rebuilt.value).toEqual(last);
		expect(rebuilt.value).not.toBe(last);
		rebuilt.dispose();
		await harness.close(context);
	});
});
