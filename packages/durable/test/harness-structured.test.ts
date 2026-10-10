import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Models,
	type ToolResultMessage,
	Type,
} from "@earendil-works/pi-ai";
import {
	type AgentEvent,
	type Conversation,
	type ConversationId,
	createSession,
	defineDoc,
	defineTask,
	defineTool,
	GenerationTask,
	type Harness,
	type JoinPolicy,
	LiveDoc,
	MemoryStorage,
	type NextTaskState,
	type Registry,
	type Storage,
	type TaskId,
	type TaskOptions,
	type TaskRuntime,
	type ToolRegistration,
	ToolResultEntry,
	type Tx,
	watchEvents,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, chatSetup, openChat, waitFor } from "./chat-support.ts";
import { addHooks, addTask, addTool } from "./harness-support.ts";
import { ControlledStorage, context } from "./session-support.ts";
import { aborted, type Deferred, deferred, openTasks, settled } from "./task-support.ts";

// ─── A scriptable task ──────────────────────────────────────────────────────

type NodeInput = { name: string };
type NodeCheckpoint = { phase: "run" } | { phase: "resume"; round: number };
type NodeRuntime = TaskRuntime<NodeInput, NodeCheckpoint, string, object>;
type Next = NextTaskState<NodeCheckpoint, string>;

/** Per-name behavior of `Node`; unscripted parts use the defaults below. */
type Behavior = {
	run?(runtime: NodeRuntime, ctx: Context): Promise<void>;
	resume?(runtime: NodeRuntime, ctx: Context, round: number): Promise<void>;
	abort?(runtime: NodeRuntime, ctx: Context): Promise<void>;
};

/** How a default run ends once its gate opens: its outcome, or a throw that faults it. */
type Ending = "completed" | "failed" | "throw";

const behaviors = new Map<string, Behavior>();
const gates = new Map<string, Deferred<Ending>>();
/** Handler starts and ends in order, such as `run:a`, `abort:a`. */
const log: string[] = [];

function gate(name: string): Deferred<Ending> {
	let found = gates.get(name);
	if (found === undefined) {
		found = deferred<Ending>();
		gates.set(name, found);
	}
	return found;
}

function open(name: string, ending: Ending = "completed"): void {
	gate(name).resolve(ending);
}

function script(name: string, behavior: Behavior): void {
	behaviors.set(name, behavior);
}

/** Wait for the gate or the abort signal, then end as the gate says. */
async function defaultRun(runtime: NodeRuntime, ctx: Context, name: string): Promise<void> {
	const ending = await Promise.race([gate(name).promise, aborted(runtime.signal)]);
	if (ending === "throw") throw new Error(`${name} threw`);
	await runtime.commit(() => end(ending, name), ctx);
}

function end(ending: "completed" | "failed", name: string): Next {
	return ending === "completed"
		? { status: "terminal", outcome: { status: "completed", result: name } }
		: { status: "terminal", outcome: { status: "failed", error: { message: `${name} failed` } } };
}

/** A task that runs its name's behavior. */
const Node = defineTask<NodeInput, NodeCheckpoint, string>({
	name: "test.node",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, ctx) => {
			const name = task.input.name;
			log.push(`run:${name}`);
			const behavior = behaviors.get(name)?.run;
			await (behavior === undefined ? defaultRun(runtime, ctx, name) : behavior(runtime, ctx));
		},
		resume: async (task, runtime, ctx) => {
			const name = task.input.name;
			log.push(`resume:${name}`);
			const behavior = behaviors.get(name)?.resume;
			if (behavior !== undefined) return behavior(runtime, ctx, task.state.checkpoint.round);
			await runtime.commit(() => end("completed", name), ctx);
		},
	},
	abort: async (task, runtime, ctx) => {
		const name = task.input.name;
		log.push(`abort:${name}`);
		const behavior = behaviors.get(name)?.abort;
		if (behavior !== undefined) return behavior(runtime, ctx);
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: name } }), ctx);
	},
});

/** Never registered: aborting it can only orphan it. */
const Unregistered = defineTask<NodeInput, { phase: "run" }, string>({
	name: "test.unregistered",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: { run: async () => {} },
	abort: async () => {},
});

const TaskNotes = defineDoc<{ text: string }>({
	kind: "test.task-notes",
	version: 1,
	scope: "task",
	initial: () => ({ text: "" }),
});

const OWN_CONVERSATION: TaskOptions = { ownership: { kind: "conversation" } };

function owned(owner: TaskId): TaskOptions {
	return { ownership: { kind: "task", taskId: owner } };
}

/** A child task named `name`, owned by `owner`. */
function spawn(tx: Tx, owner: TaskId, name: string): Promise<TaskId<string>> {
	return tx.createTask(Node, { name }, owned(owner));
}

/** Wait on `on`, resuming in round `round`. */
function waitOn(on: readonly TaskId[], policy: JoinPolicy, round = 1): Next {
	return { status: "waiting", checkpoint: { phase: "resume", round }, on, policy };
}

async function start(conversation: Conversation, name: string, options: TaskOptions = OWN_CONVERSATION) {
	return conversation.commit((tx) => tx.createTask(Node, { name }, options), context);
}

type Opened = { harness: Harness; root: Conversation; registry: Registry; reports: unknown[] };

async function openNodes(storage: Storage = new MemoryStorage()): Promise<Opened> {
	const opened = await openTasks(storage, [Node]);
	const root = await opened.harness.root(context);
	opened.harness.resume();
	return { ...opened, root };
}

async function state(harness: Harness, id: TaskId) {
	return (await harness.getTask(id, context))!.state;
}

async function outcomeOf(harness: Harness, id: TaskId): Promise<string> {
	return (await harness.waitForTask(id, context)).state.outcome.status;
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
	await waitFor(check);
}

const directories = new Set<string>();

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-structured-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

afterEach(async () => {
	behaviors.clear();
	gates.clear();
	log.length = 0;
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

// ─── Ownership ──────────────────────────────────────────────────────────────

describe("task ownership", () => {
	it("creates a child in its owner's conversation with its owner recorded", async () => {
		const { harness, root } = await openNodes();
		let child: TaskId | undefined;
		script("parent", {
			run: (runtime, ctx) =>
				runtime.commit(async (tx) => {
					child = await spawn(tx, runtime.taskId, "child");
					return waitOn([child], "allSettled");
				}, ctx),
		});
		const parent = await start(root, "parent");
		await until(() => child !== undefined);
		const record = (await harness.getTask(child!, context))!;
		expect(record).toMatchObject({ owner: parent, conversationId: root.id, background: false });
		expect((await harness.getTask(parent, context))!.owner).toBeUndefined();
		open("child");
		expect(await outcomeOf(harness, parent)).toBe("completed");
		await harness.close(context);
	});

	it("rejects no ownership, a missing owner, a child in another conversation, and a background child", async () => {
		const { harness, root } = await openNodes();
		const parent = await start(root, "parent");
		const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const create = (options: TaskOptions) =>
			root.commit((tx) => tx.createTask(Node, { name: "x" }, options), context);
		await expect(create({} as TaskOptions)).rejects.toThrow();
		await expect(create(owned(999_999 as TaskId))).rejects.toThrow("does not exist");
		await expect(create({ ...owned(parent), conversationId: other.id })).rejects.toThrow("owner's conversation");
		await expect(create({ ...owned(parent), background: true })).rejects.toThrow("cannot be background");
		// The owner's conversation is the default, even from a commit bound to another conversation.
		const child = await other.commit((tx) => spawn(tx, parent, "child"), context);
		expect((await harness.getTask(child, context))!.conversationId).toBe(root.id);
		open("parent");
		open("child");
		await harness.waitForTask(parent, context);
		await harness.close(context);
	});

	it("rejects new owned work below an owner that is completing, terminal, or abort-marked", async () => {
		const { harness, root } = await openNodes();
		script("parent", {
			run: async (runtime, ctx) => {
				await runtime.commit(async (tx) => {
					await spawn(tx, runtime.taskId, "child");
					return { status: "running", checkpoint: { phase: "resume", round: 1 } };
				}, ctx);
			},
		});
		const parent = await start(root, "parent");
		await until(async () => (await state(harness, parent)).status === "completing");
		const createChild = () => root.commit((tx) => spawn(tx, parent, "late"), context);
		const createConversation = () =>
			root.commit((tx) => tx.createConversation({ ownership: { kind: "task", taskId: parent } }), context);
		await expect(createChild()).rejects.toThrow("is completing");
		await expect(createConversation()).rejects.toThrow("is completing");
		open("child");
		await harness.waitForTask(parent, context);
		await expect(createChild()).rejects.toThrow("is terminal");
		await expect(createConversation()).rejects.toThrow("is terminal");

		script("slow", {
			abort: async (runtime, ctx) => {
				await gate("abort.slow").promise;
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		const slow = await start(root, "slow");
		await until(() => log.includes("run:slow"));
		await harness.abortTask(slow, context);
		await expect(root.commit((tx) => spawn(tx, slow, "late"), context)).rejects.toThrow("is abort-marked");
		open("abort.slow");
		expect(await outcomeOf(harness, slow)).toBe("aborted");
		await harness.close(context);
	});

	it("cannot create a child in its finishing commit, but work it starts in an owned conversation holds it", async () => {
		const { harness, root } = await openNodes();
		script("eager", {
			run: (runtime, ctx) =>
				runtime.commit(async (tx) => {
					await spawn(tx, runtime.taskId, "never");
					return end("completed", "eager");
				}, ctx),
		});
		const eager = await start(root, "eager");
		expect((await harness.waitForTask(eager, context)).state.outcome).toMatchObject({
			status: "faulted",
			error: { message: expect.stringContaining("is completing") },
		});
		// The rejected commit wrote nothing.
		const nodes = await harness.commit((tx) => tx.scanTasks({ kind: "test.node" }, 20), context);
		expect(nodes.items.map((task) => (task.input as NodeInput).name)).toEqual(["eager"]);

		let child: ConversationId | undefined;
		script("host", {
			run: (runtime, ctx) =>
				runtime.commit(async (tx) => {
					child = (await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } })).id;
					return { status: "running", checkpoint: { phase: "resume", round: 1 } };
				}, ctx),
			resume: (runtime, ctx) =>
				runtime.commit(async (tx) => {
					await tx.createTask(Node, { name: "inner" }, { ...OWN_CONVERSATION, conversationId: child! });
					return end("completed", "host");
				}, ctx),
		});
		const host = await start(root, "host");
		await until(async () => (await state(harness, host)).status === "completing");
		expect(await settled(harness.waitForTask(host, context))).toBe(false);
		open("inner");
		expect(await outcomeOf(harness, host)).toBe("completed");
		await harness.close(context);
	});
});

// ─── Waiting ────────────────────────────────────────────────────────────────

/** Script `parent` to spawn `children` in one commit and wait on them with `policy`; it records their outcomes. */
function parentOf(parent: string, children: readonly string[], policy: JoinPolicy) {
	const found = { ids: [] as TaskId<string>[], outcomes: [] as string[] };
	script(parent, {
		run: (runtime, ctx) =>
			runtime.commit(async (tx) => {
				for (const name of children) found.ids.push(await spawn(tx, runtime.taskId, name));
				return waitOn(found.ids, policy);
			}, ctx),
		resume: async (runtime, ctx) => {
			found.outcomes = (await runtime.outcomes(found.ids, ctx)).map((outcome) => outcome.status);
			await runtime.commit(() => end("completed", parent), ctx);
		},
	});
	return found;
}

describe("waiting", () => {
	it("resumes once every awaited task is terminal and reads their outcomes in order (allSettled)", async () => {
		const { harness, root } = await openNodes();
		const found = { ids: [] as TaskId[], outcomes: [] as string[] };
		script("parent", {
			run: (runtime, ctx) =>
				runtime.commit(async (tx) => {
					for (const name of ["ok", "fails", "throws", "aborted"])
						found.ids.push(await spawn(tx, runtime.taskId, name));
					found.ids.push(await tx.createTask(Unregistered, { name: "orphan" }, owned(runtime.taskId)));
					return waitOn(found.ids, "allSettled");
				}, ctx),
			resume: async (runtime, ctx) => {
				found.outcomes = (await runtime.outcomes(found.ids, ctx)).map((outcome) => outcome.status);
				await runtime.commit(() => end("completed", "parent"), ctx);
			},
		});
		const parent = await start(root, "parent");
		await until(() => found.ids.length === 5);
		await until(async () => (await state(harness, parent)).status === "waiting");
		open("ok");
		open("fails", "failed");
		open("throws", "throw");
		await harness.abortTask(found.ids[3]!, context);
		expect(await harness.abortTask(found.ids[4]!, context)).toBe("marked");
		expect(await outcomeOf(harness, parent)).toBe("completed");
		expect(found.outcomes).toEqual(["completed", "failed", "faulted", "aborted", "orphaned"]);
		// allSettled never marks siblings.
		expect(log.filter((line) => line.startsWith("abort:"))).toEqual(["abort:aborted"]);
		await harness.close(context);
	});

	for (const ending of ["failed", "throw"] as const) {
		it(`fails fast when a child ends ${ending === "throw" ? "faulted" : "failed"}: its live siblings are aborted, the parent is not`, async () => {
			const { harness, root } = await openNodes();
			const found = parentOf("checkout", ["p1", "p2", "p3", "p4"], "failFast");
			const parent = await start(root, "checkout");
			await until(async () => (await state(harness, parent)).status === "waiting");
			open("p2", ending);
			expect(await outcomeOf(harness, parent)).toBe("completed");
			expect(found.outcomes).toEqual(["aborted", ending === "throw" ? "faulted" : "failed", "aborted", "aborted"]);
			expect((await harness.getTask(parent, context))!.abortRequested).toBe(false);
			expect(log.filter((line) => line.startsWith("abort:")).sort()).toEqual(["abort:p1", "abort:p3", "abort:p4"]);
			await harness.close(context);
		});
	}

	it("fails fast on a held failure before the failing child drains", async () => {
		const { harness, root } = await openNodes();
		const found = { ids: [] as TaskId[] };
		script("p1", {
			run: async (runtime, ctx) => {
				await runtime.commit(async (tx) => {
					await spawn(tx, runtime.taskId, "grandchild");
					return { status: "running", checkpoint: { phase: "resume", round: 1 } };
				}, ctx);
			},
			resume: (runtime, ctx) => runtime.commit(() => end("failed", "p1"), ctx),
		});
		script("grandchild", {
			abort: async (runtime, ctx) => {
				await gate("abort.grandchild").promise;
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		let outside: TaskId | undefined;
		script("parent", {
			run: (runtime, ctx) =>
				runtime.commit(async (tx) => {
					for (const name of ["p1", "p2"]) found.ids.push(await spawn(tx, runtime.taskId, name));
					outside = await spawn(tx, runtime.taskId, "outside");
					return waitOn(found.ids, "failFast");
				}, ctx),
		});
		const parent = await start(root, "parent");
		await until(() => found.ids.length === 2);
		// p1 holds `failed` while its grandchild's abort handler runs; p2 is already aborted.
		expect(await outcomeOf(harness, found.ids[1]!)).toBe("aborted");
		expect(await state(harness, found.ids[0]!)).toMatchObject({
			status: "completing",
			outcome: { status: "failed" },
		});
		expect((await state(harness, parent)).status).toBe("waiting");
		open("abort.grandchild");
		await until(() => log.includes("resume:parent"));
		// Only the other tasks in `on` are marked: not the failed one, not the parent, not a child outside `on`.
		const marked = async (id: TaskId) => (await harness.getTask(id, context))!.abortRequested;
		expect(await outcomeOf(harness, found.ids[0]!)).toBe("failed");
		expect([await marked(found.ids[0]!), await marked(found.ids[1]!), await marked(outside!)]).toEqual([
			false,
			true,
			false,
		]);
		expect(await marked(parent)).toBe(false);
		expect((await state(harness, outside!)).status).toBe("running");
		// Finished, the parent holds for the child outside `on`.
		await until(async () => (await state(harness, parent)).status === "completing");
		open("outside");
		expect(await outcomeOf(harness, parent)).toBe("completed");
		await harness.close(context);
	});

	it("waits with allSettled on tasks it does not own, including already terminal ones", async () => {
		const { harness, root } = await openNodes();
		const done = await start(root, "done");
		open("done");
		await harness.waitForTask(done, context);
		const live = await start(root, "live");
		let outcomes: string[] = [];
		script("parent", {
			run: (runtime, ctx) => runtime.commit(() => waitOn([done, live], "allSettled"), ctx),
			resume: async (runtime, ctx) => {
				outcomes = (await runtime.outcomes([done, live], ctx)).map((outcome) => outcome.status);
				await runtime.commit(() => end("completed", "parent"), ctx);
			},
		});
		const parent = await start(root, "parent");
		await until(async () => (await state(harness, parent)).status === "waiting");
		// A task it does not own is not its work: the parent may finish while it lives, but here it waits for it.
		open("live", "failed");
		expect(await outcomeOf(harness, parent)).toBe("completed");
		expect(outcomes).toEqual(["completed", "failed"]);
		await harness.close(context);
	});

	it("rejects waits on itself, its owner, a missing task, and failFast on a task it does not own", async () => {
		const { harness, root } = await openNodes();
		const other = await start(root, "other");
		const cases: [string, (runtime: NodeRuntime) => readonly TaskId[], JoinPolicy, string][] = [
			["self", (runtime) => [runtime.taskId], "allSettled", "cannot close a wait cycle"],
			["missing", () => [999_999 as TaskId], "allSettled", "does not exist"],
			["foreign", () => [other], "failFast", "only on tasks it owns"],
		];
		for (const [name, on, policy, message] of cases) {
			script(name, { run: (runtime, ctx) => runtime.commit(() => waitOn(on(runtime), policy), ctx) });
			const id = await start(root, name);
			expect((await harness.waitForTask(id, context)).state.outcome).toMatchObject({
				status: "faulted",
				error: { message: expect.stringContaining(message) },
			});
		}
		// A child waiting on its owner could never resume.
		let child: TaskId | undefined;
		let parent: TaskId | undefined;
		script("child", { run: (runtime, ctx) => runtime.commit(() => waitOn([parent!], "allSettled"), ctx) });
		script("parent", {
			run: (runtime, ctx) =>
				runtime.commit(async (tx) => {
					child = await spawn(tx, runtime.taskId, "child");
					return waitOn([child], "allSettled");
				}, ctx),
		});
		parent = await start(root, "parent");
		expect((await harness.waitForTask(parent, context)).state.outcome.status).toBe("completed");
		expect((await harness.waitForTask(child!, context)).state.outcome).toMatchObject({
			status: "faulted",
			error: { message: expect.stringContaining("cannot close a wait cycle") },
		});
		open("other");
		await harness.close(context);
	});

	// #10411
	it("rejects the wait that closes a cycle", async () => {
		const { harness, root } = await openNodes();
		let a: TaskId | undefined;
		let b: TaskId | undefined;
		script("a", { run: (runtime, ctx) => runtime.commit(() => waitOn([b!], "allSettled"), ctx) });
		script("b", { run: (runtime, ctx) => runtime.commit(() => waitOn([a!], "allSettled"), ctx) });
		await root.commit(async (tx) => {
			a = await tx.createTask(Node, { name: "a" }, OWN_CONVERSATION);
			b = await tx.createTask(Node, { name: "b" }, OWN_CONVERSATION);
		}, context);
		// a → b and b → a are waits, and whichever comes second closes the cycle.
		const outcomes = await Promise.all([outcomeOf(harness, a!), outcomeOf(harness, b!)]);
		expect(outcomes.sort()).toEqual(["completed", "faulted"]);
		await harness.close(context);
	});

	// #10411
	it("rejects the wait that closes a cycle through a held owner", async () => {
		const { harness, root } = await openNodes();
		let held: TaskId | undefined;
		let other: TaskId | undefined;
		const child = spawnAndFinish("held", "child");
		script("child", { run: (runtime, ctx) => runtime.commit(() => waitOn([other!], "allSettled"), ctx) });
		script("other", { run: (runtime, ctx) => runtime.commit(() => waitOn([held!], "allSettled"), ctx) });
		await root.commit(async (tx) => {
			held = await tx.createTask(Node, { name: "held" }, OWN_CONVERSATION);
			other = await tx.createTask(Node, { name: "other" }, OWN_CONVERSATION);
		}, context);
		// held → child is a hold; child → other → held are waits, and whichever wait comes second closes the cycle.
		expect(await outcomeOf(harness, held!)).toBe("completed");
		const outcomes = await Promise.all([outcomeOf(harness, child.id!), outcomeOf(harness, other!)]);
		expect(outcomes.sort()).toEqual(["completed", "faulted"]);
		await harness.close(context);
	});

	// #10411
	it("lets a background task wait on the owner of its conversation", async () => {
		const { harness, root } = await openNodes();
		let owner: TaskId | undefined;
		script("background", { run: (runtime, ctx) => runtime.commit(() => waitOn([owner!], "allSettled"), ctx) });
		const background = await root.commit(async (tx) => {
			owner = await tx.createTask(Node, { name: "owner" }, OWN_CONVERSATION);
			const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
			const options = { ...OWN_CONVERSATION, conversationId: conversation.id, background: true };
			return tx.createTask(Node, { name: "background" }, options);
		}, context);
		// background → owner is a wait but owner → background is no hold, so there is no cycle. The owner stays live,
		// so the wait is checked rather than skipped.
		await until(async () => (await state(harness, background)).status === "waiting");
		open("owner");
		expect(await outcomeOf(harness, background)).toBe("completed");
		await harness.close(context);
	});

	it("resumes at the next pass when it waits on nothing", async () => {
		const { harness, root } = await openNodes();
		script("parent", { run: (runtime, ctx) => runtime.commit(() => waitOn([], "failFast"), ctx) });
		expect(await outcomeOf(harness, await start(root, "parent"))).toBe("completed");
		expect(log).toEqual(["run:parent", "resume:parent"]);
		await harness.close(context);
	});

	it("keeps running phases after spawning and waits on subsets in sequence", async () => {
		const { harness, root } = await openNodes();
		const ids: TaskId[] = [];
		script("parent", {
			run: async (runtime, ctx) => {
				await runtime.commit(async (tx) => {
					for (const name of ["a", "b", "c"]) ids.push(await spawn(tx, runtime.taskId, name));
					return { status: "running", checkpoint: { phase: "resume", round: 0 } };
				}, ctx);
			},
			resume: async (runtime, ctx, round) => {
				log.push(`round:${round}`);
				if (round === 0) return runtime.commit(() => waitOn([ids[0]!], "allSettled", 1), ctx);
				if (round === 1) return runtime.commit(() => waitOn([ids[1]!, ids[2]!], "failFast", 2), ctx);
				await runtime.commit(() => end("completed", "parent"), ctx);
			},
		});
		const parent = await start(root, "parent");
		await until(() => log.includes("round:0"));
		await until(async () => (await state(harness, parent)).status === "waiting");
		open("b");
		expect(await settled(harness.waitForTask(ids[1]!, context))).toBe(true);
		expect((await state(harness, parent)).status).toBe("waiting");
		open("a");
		await until(() => log.includes("round:1"));
		open("c");
		expect(await outcomeOf(harness, parent)).toBe("completed");
		expect(log.filter((line) => line.startsWith("round:"))).toEqual(["round:0", "round:1", "round:2"]);
		await harness.close(context);
	});
});

// ─── Completing ─────────────────────────────────────────────────────────────

describe("completing", () => {
	it("holds a finished task until its owned work drains; waiters and task documents wait for the final commit", async () => {
		const { harness, root } = await openNodes();
		let child: TaskId | undefined;
		script("parent", {
			run: async (runtime, ctx) => {
				await runtime.commit(async (tx) => {
					(await tx.doc(TaskNotes, runtime.taskId)).text = "notes";
					child = await spawn(tx, runtime.taskId, "child");
					return { status: "running", checkpoint: { phase: "resume", round: 1 } };
				}, ctx);
			},
		});
		const parent = await start(root, "parent");
		await until(async () => (await state(harness, parent)).status === "completing");
		expect(await state(harness, parent)).toEqual({
			status: "completing",
			outcome: { status: "completed", result: "parent" },
		});
		const waiter = harness.waitForTask(parent, context);
		expect(await settled(waiter)).toBe(false);
		expect(await harness.snapshot(TaskNotes, parent, context)).toEqual({ text: "notes" });
		expect((await harness.inspect(context)).tasks.find((task) => task.record.id === parent)?.state).toEqual({
			kind: "completing",
		});
		expect(await settled(root.waitForIdle(context))).toBe(false);
		open("child");
		expect((await waiter).state.outcome).toEqual({ status: "completed", result: "parent" });
		expect(await harness.snapshot(TaskNotes, parent, context)).toBeUndefined();
		await root.waitForIdle(context);
		expect(child).toBeDefined();
		await harness.close(context);
	});

	it("keeps holding for ordinary work created during the hold", async () => {
		const { harness, root } = await openNodes();
		let conversation: ConversationId | undefined;
		script("parent", {
			run: async (runtime, ctx) => {
				await runtime.commit(async (tx) => {
					conversation = (await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } })).id;
					await tx.createTask(Node, { name: "first" }, { ...OWN_CONVERSATION, conversationId: conversation });
					return { status: "running", checkpoint: { phase: "resume", round: 1 } };
				}, ctx);
			},
		});
		const parent = await start(root, "parent");
		await until(async () => (await state(harness, parent)).status === "completing");
		const child = (await harness.conversation(conversation!, context))!;
		await start(child, "second");
		open("first");
		await until(() => log.includes("run:second"));
		expect((await state(harness, parent)).status).toBe("completing");
		open("second");
		expect(await outcomeOf(harness, parent)).toBe("completed");
		await harness.close(context);
	});

	for (const [label, ending] of [
		["a held failure", "failed"],
		["a held scheduler fault", "throw"],
	] as const) {
		it(`aborts the work below ${label}, then finishes with the held outcome`, async () => {
			const { harness, root } = await openNodes();
			let child: TaskId | undefined;
			script("parent", {
				run: async (runtime, ctx) => {
					await runtime.commit(async (tx) => {
						child = await spawn(tx, runtime.taskId, "child");
						return { status: "running", checkpoint: { phase: "resume", round: 1 } };
					}, ctx);
				},
				resume: async (runtime, ctx) => {
					if (ending === "throw") throw new Error("parent threw");
					await runtime.commit(() => end("failed", "parent"), ctx);
				},
			});
			const parent = await start(root, "parent");
			await until(() => child !== undefined);
			expect(await outcomeOf(harness, child!)).toBe("aborted");
			expect(await outcomeOf(harness, parent)).toBe(ending === "throw" ? "faulted" : "failed");
			await harness.close(context);
		});
	}

	it("only marks a completing task when aborted: the work below is aborted, the held outcome stays", async () => {
		const { harness, root } = await openNodes();
		let child: TaskId | undefined;
		script("parent", {
			run: async (runtime, ctx) => {
				await runtime.commit(async (tx) => {
					child = await spawn(tx, runtime.taskId, "child");
					return { status: "running", checkpoint: { phase: "resume", round: 1 } };
				}, ctx);
			},
		});
		const parent = await start(root, "parent");
		await until(async () => (await state(harness, parent)).status === "completing");
		expect(await harness.abortTask(parent, context)).toBe("marked");
		expect(await outcomeOf(harness, child!)).toBe("aborted");
		const settledParent = await harness.waitForTask(parent, context);
		expect(settledParent.state.outcome).toEqual({ status: "completed", result: "parent" });
		expect(settledParent.abortRequested).toBe(true);
		expect(log).not.toContain("abort:parent");
		expect(await harness.abortTask(parent, context)).toBe("terminal");
		await harness.close(context);
	});
});

// ─── Abort order ────────────────────────────────────────────────────────────

describe("abort order", () => {
	/** Script `name` to spawn `child` and wait on it; its abort handler records the child's status first. */
	function chain(harness: () => Harness, name: string, child: string): { id?: TaskId } {
		const found: { id?: TaskId } = {};
		script(name, {
			run: (runtime, ctx) =>
				runtime.commit(async (tx) => {
					found.id = await spawn(tx, runtime.taskId, child);
					return waitOn([found.id], "allSettled");
				}, ctx),
			abort: async (runtime, ctx) => {
				log.push(`${name} saw ${(await harness().getTask(found.id!, context))!.state.status}`);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		return found;
	}

	it("runs abort handlers bottom-up across three levels, each after the level below is terminal", async () => {
		let opened: Opened | undefined;
		const b = chain(() => opened!.harness, "a", "b");
		const c = chain(() => opened!.harness, "b", "c");
		opened = await openNodes();
		const { harness, root } = opened;
		const a = await start(root, "a");
		await until(() => log.includes("run:c"));
		await until(async () => (await state(harness, c.id!)).status === "running");
		expect(await harness.abortTask(a, context)).toBe("marked");
		expect(await outcomeOf(harness, a)).toBe("aborted");
		expect(log.filter((line) => line.startsWith("abort:") || line.includes(" saw "))).toEqual([
			"abort:c",
			"abort:b",
			"b saw terminal",
			"abort:a",
			"a saw terminal",
		]);
		expect(b.id).toBeDefined();
		await harness.close(context);
	});

	it("does not wait for a task it waits on but does not own", async () => {
		const { harness, root } = await openNodes();
		const other = await start(root, "other");
		script("parent", { run: (runtime, ctx) => runtime.commit(() => waitOn([other], "allSettled"), ctx) });
		const parent = await start(root, "parent");
		await until(async () => (await state(harness, parent)).status === "waiting");
		await harness.abortTask(parent, context);
		expect(await outcomeOf(harness, parent)).toBe("aborted");
		expect((await state(harness, other)).status).toBe("running");
		open("other");
		await harness.close(context);
	});

	it("reports an abort-marked task as waiting for its live owned work", async () => {
		const { harness, root } = await openNodes();
		let child: TaskId | undefined;
		script("child", {
			abort: async (runtime, ctx) => {
				await gate("abort.child").promise;
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		script("parent", {
			run: (runtime, ctx) =>
				runtime.commit(async (tx) => {
					child = await spawn(tx, runtime.taskId, "child");
					return waitOn([child], "allSettled");
				}, ctx),
		});
		const parent = await start(root, "parent");
		await until(async () => (await state(harness, parent)).status === "waiting");
		await harness.abortTask(parent, context);
		await until(() => log.includes("abort:child"));
		const inspected = (await harness.inspect(context)).tasks.find((task) => task.record.id === parent);
		expect(inspected?.state).toEqual({ kind: "waiting", on: [child] });
		open("abort.child");
		expect(await outcomeOf(harness, parent)).toBe("aborted");
		await harness.close(context);
	});

	it("faults an abort handler that tries to wait", async () => {
		const { harness, root } = await openNodes();
		script("parent", { abort: (runtime, ctx) => runtime.commit(() => waitOn([], "allSettled"), ctx) });
		const parent = await start(root, "parent");
		await until(() => log.includes("run:parent"));
		await harness.abortTask(parent, context);
		expect((await harness.waitForTask(parent, context)).state.outcome).toMatchObject({
			status: "faulted",
			error: { message: expect.stringContaining("cannot wait") },
		});
		await harness.close(context);
	});

	it("orphans a blocked task only after its owned work drained", async () => {
		const { harness, root } = await openNodes();
		const { owner, child } = await root.commit(async (tx) => {
			const owner = await tx.createTask(Unregistered, { name: "owner" }, OWN_CONVERSATION);
			return { owner, child: await spawn(tx, owner, "child") };
		}, context);
		await until(() => log.includes("run:child"));
		expect(await harness.abortTask(owner, context)).toBe("marked");
		expect(await outcomeOf(harness, child)).toBe("aborted");
		expect((await harness.waitForTask(owner, context)).state.outcome).toEqual({
			status: "orphaned",
			reason: "missing_task",
		});
		await harness.close(context);
	});

	it("cascades through task and conversation edges, bottom-up", async () => {
		const { harness, root } = await openNodes();
		let b: TaskId | undefined;
		let x: TaskId | undefined;
		script("a", {
			run: (runtime, ctx) =>
				runtime.commit(async (tx) => {
					b = await spawn(tx, runtime.taskId, "b");
					return waitOn([b], "allSettled");
				}, ctx),
		});
		script("b", {
			run: async (runtime, ctx) => {
				await runtime.commit(async (tx) => {
					const conversation = await tx.createConversation({
						ownership: { kind: "task", taskId: runtime.taskId },
					});
					x = await tx.createTask(Node, { name: "x" }, { ...OWN_CONVERSATION, conversationId: conversation.id });
					return { status: "running", checkpoint: { phase: "resume", round: 1 } };
				}, ctx);
			},
			resume: async (runtime) => {
				await aborted(runtime.signal);
			},
		});
		const a = await start(root, "a");
		await until(() => log.includes("run:x"));
		await harness.abortTask(a, context);
		expect(await outcomeOf(harness, a)).toBe("aborted");
		expect(await outcomeOf(harness, x!)).toBe("aborted");
		expect(log.filter((line) => line.startsWith("abort:"))).toEqual(["abort:x", "abort:b", "abort:a"]);
		await harness.close(context);
	});
});

// ─── Background and terminal owners ─────────────────────────────────────────

describe("boundaries", () => {
	it("keeps background work through Conversation.abort(); { background: true } aborts it and waits", async () => {
		const { harness, root } = await openNodes();
		const foreground = await start(root, "foreground");
		let child: TaskId | undefined;
		let below: TaskId | undefined;
		script("background", {
			run: async (runtime, ctx) => {
				await runtime.commit(async (tx) => {
					child = await spawn(tx, runtime.taskId, "child");
					const conversation = await tx.createConversation({
						ownership: { kind: "task", taskId: runtime.taskId },
					});
					below = await tx.createTask(
						Node,
						{ name: "below" },
						{ ...OWN_CONVERSATION, conversationId: conversation.id },
					);
					return waitOn([child], "allSettled");
				}, ctx);
			},
		});
		const background = await start(root, "background", { ...OWN_CONVERSATION, background: true });
		await until(() => log.includes("run:below") && log.includes("run:child"));
		await root.abort(context);
		expect(await outcomeOf(harness, foreground)).toBe("aborted");
		for (const id of [background, child!, below!]) expect((await state(harness, id)).status).not.toBe("terminal");
		await root.abort(context, { background: true });
		for (const id of [background, child!, below!]) expect((await state(harness, id)).status).toBe("terminal");
		await harness.close(context);
	});

	it("never cascades from a terminal owner: an aborted subagent's conversation runs new work normally", async () => {
		const { harness, root } = await openNodes();
		let conversation: ConversationId | undefined;
		script("agent", {
			run: async (runtime, ctx) => {
				await runtime.commit(async (tx) => {
					conversation = (await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } })).id;
					return { status: "running", checkpoint: { phase: "resume", round: 1 } };
				}, ctx);
			},
			resume: async (runtime) => {
				await aborted(runtime.signal);
			},
		});
		const agent = await start(root, "agent");
		await until(() => log.includes("resume:agent"));
		await harness.abortTask(agent, context);
		expect(await outcomeOf(harness, agent)).toBe("aborted");
		const child = (await harness.conversation(conversation!, context))!;
		const question = await start(child, "question");
		open("question");
		expect(await outcomeOf(harness, question)).toBe("completed");
		await harness.close(context);
	});
});

// ─── Recovery ───────────────────────────────────────────────────────────────

type Seeded = { parent: TaskId; children: TaskId[] };

/**
 * Write records a crash could leave, without a Harness: `parent` with children named `children`, then `edit` replaces
 * states through the internal task write.
 */
async function seed(
	path: string,
	children: readonly string[],
	edit: (set: (id: TaskId, patch: object) => Promise<void>, seeded: Seeded) => Promise<void>,
): Promise<Seeded> {
	const session = createSession(await openNodeSqliteStorage(path));
	const seeded = await session.commit(async (tx) => {
		const root = await tx.createConversation({ ownership: { kind: "ownerless" } });
		const parent = await tx.createTask(Node, { name: "parent" }, { ...OWN_CONVERSATION, conversationId: root.id });
		const ids: TaskId[] = [];
		for (const name of children) ids.push(await spawn(tx, parent, name));
		return { parent, children: ids };
	}, context);
	await edit(async (id, patch) => {
		await session.commit(async (tx) => {
			const record = (await tx.task(id))!;
			(tx as unknown as { setTask(value: unknown): void }).setTask({ ...record, ...patch });
		}, context);
	}, seeded);
	await session.close(context);
	return seeded;
}

const COMPLETED = { status: "terminal", outcome: { status: "completed", result: "done" } };
const FAILED = { status: "terminal", outcome: { status: "failed", error: { message: "declined" } } };

describe("recovery", () => {
	it("resumes a parent whose awaited children finished before the crash", async () => {
		const path = await sqlitePath();
		const { parent, children } = await seed(path, ["c1"], async (set, { parent, children }) => {
			await set(children[0]!, { state: COMPLETED });
			await set(parent, {
				state: { status: "waiting", checkpoint: { phase: "resume", round: 1 }, on: children, policy: "allSettled" },
			});
		});
		const { harness } = await openNodes(await openNodeSqliteStorage(path));
		expect(await outcomeOf(harness, parent)).toBe("completed");
		expect(log).toEqual(["resume:parent"]);
		expect(children).toHaveLength(1);
		await harness.close(context);
	});

	it("marks failFast siblings a crash left unmarked", async () => {
		const path = await sqlitePath();
		const { parent, children } = await seed(path, ["c1", "c2"], async (set, { parent, children }) => {
			await set(children[0]!, { state: FAILED });
			await set(parent, {
				state: { status: "waiting", checkpoint: { phase: "resume", round: 1 }, on: children, policy: "failFast" },
			});
		});
		const { harness } = await openNodes(await openNodeSqliteStorage(path));
		expect(await outcomeOf(harness, children[1]!)).toBe("aborted");
		expect(await outcomeOf(harness, parent)).toBe("completed");
		expect(log).not.toContain("run:c2");
		await harness.close(context);
	});

	it("finalizes a held outcome whose work drained before the crash, and keeps one whose work lives", async () => {
		const path = await sqlitePath();
		const held = { status: "completing", outcome: { status: "completed", result: "parent" } };
		const { parent, children } = await seed(path, ["c1"], async (set, { parent }) => {
			await set(parent, { state: held });
		});
		let opened = await openNodes(await openNodeSqliteStorage(path));
		await until(() => log.includes("run:c1"));
		expect(await state(opened.harness, parent)).toEqual(held);
		await opened.harness.close(context);

		opened = await openNodes(await openNodeSqliteStorage(path));
		open("c1");
		expect(await outcomeOf(opened.harness, children[0]!)).toBe("completed");
		expect(await outcomeOf(opened.harness, parent)).toBe("completed");
		await opened.harness.close(context);

		const drained = await sqlitePath();
		const second = await seed(drained, ["c1"], async (set, { parent, children }) => {
			await set(children[0]!, { state: COMPLETED });
			await set(parent, { state: held });
		});
		opened = await openNodes(await openNodeSqliteStorage(drained));
		expect(await outcomeOf(opened.harness, second.parent)).toBe("completed");
		await opened.harness.close(context);
	});

	it("resumes a bottom-up abort a crash interrupted before the cascade", async () => {
		const path = await sqlitePath();
		const { parent, children } = await seed(path, ["c1"], async (set, { parent, children }) => {
			await set(parent, {
				abortRequested: true,
				state: { status: "waiting", checkpoint: { phase: "resume", round: 1 }, on: children, policy: "allSettled" },
			});
		});
		const { harness } = await openNodes(await openNodeSqliteStorage(path));
		expect(await outcomeOf(harness, parent)).toBe("aborted");
		expect(await outcomeOf(harness, children[0]!)).toBe("aborted");
		expect(log.filter((line) => line.startsWith("abort:"))).toEqual(["abort:c1", "abort:parent"]);
		await harness.close(context);
	});

	it("reopens a checkout waiting on live payments and finishes it", async () => {
		const path = await sqlitePath();
		const found = parentOf("checkout", ["p1", "p2"], "failFast");
		let opened = await openNodes(await openNodeSqliteStorage(path));
		const parent = await start(opened.root, "checkout");
		await until(async () => (await state(opened.harness, parent)).status === "waiting");
		await until(() => log.includes("run:p1") && log.includes("run:p2"));
		await opened.harness.close(context);

		opened = await openNodes(await openNodeSqliteStorage(path));
		found.ids.splice(
			0,
			found.ids.length,
			...((await state(opened.harness, parent)) as unknown as { on: TaskId<string>[] }).on,
		);
		open("p1");
		open("p2");
		expect(await outcomeOf(opened.harness, parent)).toBe("completed");
		expect(found.outcomes).toEqual(["completed", "completed"]);
		await opened.harness.close(context);
	});
});

// ─── Built-in tool rounds ───────────────────────────────────────────────────

function blockingTool(name: string): { started: Promise<void>; registration: ToolRegistration } {
	const started = deferred();
	return {
		started: started.promise,
		registration: defineTool({
			name,
			description: `The ${name} tool`,
			parameters: Type.Object({}),
			executionMode: "sequential",
			execute: async (_args, api, callContext) => {
				api.output("partial");
				started.resolve();
				return aborted(callContext.abortSignal!);
			},
		}),
	};
}

function toolCalls(...ids: readonly [string, string][]) {
	return fauxAssistantMessage(
		ids.map(([name, id]) => fauxToolCall(name, {}, { id })),
		{ stopReason: "toolUse" },
	);
}

describe("tool rounds", () => {
	it("owns its tool tasks, waits for them, and hands the run to a conversation-owned generation", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			defineTool({
				name: "noop",
				description: "Does nothing",
				parameters: Type.Object({}),
				execute: async () => ({ output: [] }),
			}),
		);
		setup.faux.setResponses([toolCalls(["noop", "c1"], ["noop", "c2"]), fauxAssistantMessage([fauxText("done")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect((await (await root.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe("done");
		const tasks = (await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 20), context)).items;
		const [first, second] = tasks.filter((task) => task.kind === "pi.generation");
		expect(tasks.filter((task) => task.kind === "pi.tool").map((task) => task.owner)).toEqual([first!.id, first!.id]);
		expect(first!.owner).toBeUndefined();
		expect(second!.owner).toBeUndefined();
		const assistant = (await allEntries(root)).find((entry) => entry.kind === "pi.assistant")!;
		expect(first!.state).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: { entryId: assistant.id } },
		});
		await harness.close(context);
	});

	it("aborts a parallel round with its generation: tools first, then the generation, with every result written", async () => {
		const setup = chatSetup();
		const one = blockingTool("one");
		const two = blockingTool("two");
		addTool(setup.registry, defineTool({ ...one.registration, executionMode: "parallel" }));
		addTool(setup.registry, defineTool({ ...two.registration, executionMode: "parallel" }));
		setup.faux.setResponses([toolCalls(["one", "c1"], ["two", "c2"])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await Promise.all([one.started, two.started]);
		const generation = (await harness.snapshot(LiveDoc, root.id, context))!.run!.taskId;
		await harness.abortTask(generation, context);
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		const results = (await allEntries(root)).filter((entry) => ToolResultEntry.is(entry));
		expect(results.map((entry) => (entry.model![0] as ToolResultMessage).toolCallId)).toEqual(["c1", "c2"]);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		expect((await harness.waitForTask(generation, context)).state.outcome.status).toBe("aborted");
		await harness.close(context);
	});

	it("answers the unstarted calls of an aborted sequential round with aborted results, in call order", async () => {
		const setup = chatSetup();
		const one = blockingTool("one");
		addTool(setup.registry, one.registration);
		addTool(setup.registry, defineTool({ ...blockingTool("two").registration, name: "two" }));
		setup.faux.setResponses([toolCalls(["one", "c1"], ["two", "c2"], ["two", "c3"])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await one.started;
		expect(
			(await harness.snapshot(LiveDoc, root.id, context))!.tools!.map((slot) => slot.taskId !== undefined),
		).toEqual([true, false, false]);
		const generation = (await harness.snapshot(LiveDoc, root.id, context))!.run!.taskId;
		await harness.abortTask(generation, context);
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		const results = (await allEntries(root))
			.filter((entry) => ToolResultEntry.is(entry))
			.map((entry) => entry.model![0] as ToolResultMessage);
		expect(results.map((result) => result.toolCallId)).toEqual(["c1", "c2", "c3"]);
		expect(results.map((result) => result.isError)).toEqual([true, true, true]);
		expect(results[1]!.content).toEqual([
			{ type: "text", text: "<harness>\n[error] Tool two was aborted\n</harness>" },
		]);
		const tools = (
			await harness.commit((tx) => tx.scanTasks({ conversationId: root.id, kind: "pi.tool" }, 20), context)
		).items;
		expect(tools).toHaveLength(1);
		await harness.close(context);
	});

	it("ends a turn at the generation's hold, before its successor's turn starts", async () => {
		const setup = chatSetup();
		addTask(setup.registry, Node);
		addTool(
			setup.registry,
			defineTool({
				name: "noop",
				description: "Does nothing",
				parameters: Type.Object({}),
				execute: async () => ({ output: [] }),
			}),
		);
		// An extension's hook starts work owned by the generation, which holds it while the next turn runs.
		let opened: Harness | undefined;
		addHooks(setup.registry, GenerationTask, {
			afterTools: async (_assistant, _results, api, callContext) => {
				await opened!.commit((tx) => tx.createTask(Node, { name: "hooked" }, owned(api.taskId)), callContext);
			},
		});
		setup.faux.setResponses([toolCalls(["noop", "c1"]), fauxAssistantMessage([fauxText("done")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		opened = harness;
		const stream = await watchEvents(harness, root.id, context);
		const events: AgentEvent[] = [];
		stream.start(async (batch) => {
			events.push(...batch);
		});
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const first = (await harness.commit((tx) => tx.scanTasks({ kind: "pi.generation" }, 1), context)).items[0]!;
		expect((await state(harness, first.id)).status).toBe("completing");
		const turns = () => events.filter((event) => event.type.startsWith("turn_")).map((event) => event.type);
		await waitFor(() => turns().length === 4);
		expect(turns()).toEqual(["turn_start", "turn_end", "turn_start", "turn_end"]);
		open("hooked");
		expect(await outcomeOf(harness, first.id)).toBe("completed");
		await waitFor(() => turns().length === 4);
		await stream.stop();
		await harness.close(context);
	});

	it("keeps run control with a faulted generation until its owned work drains, and fails the Harness on a failed final commit", async () => {
		const base = chatSetup();
		const models = new Proxy(base.models, {
			get(target, property) {
				if (property === "streamSimple") return invalidFinalStream;
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const setup = { ...base, models };
		addTask(setup.registry, Node);
		let opened: Harness | undefined;
		addHooks(setup.registry, GenerationTask, {
			beforeRequest: async (_request, api, callContext) => {
				await opened!.commit((tx) => tx.createTask(Node, { name: "hooked" }, owned(api.taskId)), callContext);
				return undefined;
			},
		});
		script("hooked", {
			abort: async (runtime, ctx) => {
				await gate("abort.hooked").promise;
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		let reject: TaskId | undefined;
		const failure = new Error("disk gone");
		class Failing extends ControlledStorage {
			override async commit(
				writes: Parameters<MemoryStorage["commit"]>[0],
				ctx: Parameters<MemoryStorage["commit"]>[1],
			) {
				const finalizes = writes.some(
					(write) => write.type === "task" && write.value.id === reject && write.value.state.status === "terminal",
				);
				if (finalizes) {
					reject = undefined;
					throw failure;
				}
				return super.commit(writes, ctx);
			}
		}
		const storage = new Failing();
		const { harness, root } = await openChat(storage, setup);
		opened = harness;
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await waitFor(async () => {
			const generation = (await harness.snapshot(LiveDoc, root.id, context))?.run?.taskId;
			return generation !== undefined && (await state(harness, generation)).status === "completing";
		});
		const generation = (await harness.snapshot(LiveDoc, root.id, context))!.run!.taskId;
		expect(await state(harness, generation)).toMatchObject({ status: "completing", outcome: { status: "faulted" } });
		expect(await settled(submission.wait(context))).toBe(false);
		expect((await harness.snapshot(LiveDoc, root.id, context))!.run?.taskId).toBe(generation);
		// The faulted outcome is cancellation intent: the hooked work is aborted, then the run settles.
		await waitFor(() => log.includes("abort:hooked"));
		reject = generation;
		open("abort.hooked");
		// The final commit, with the run's cleanup, fails: nothing of the cleanup lands, and the Harness fails.
		expect(await harness.closed).toEqual({ reason: "failed", error: failure });
		await expect(submission.wait(context)).rejects.toMatchObject({ name: "SessionFailed", cause: failure });
		await harness.close(context);
		// Reopening finalizes the run; the partial becomes one aborted entry.
		const reopened = await openChat(storage.reopen(), setup);
		opened = reopened.harness;
		const again = (await reopened.harness.submission(submission.id, context))!;
		expect(await again.wait(context)).toMatchObject({ status: "unanswered", reason: "faulted" });
		expect(await reopened.harness.snapshot(LiveDoc, reopened.root.id, context)).toEqual({});
		expect((await allEntries(reopened.root)).map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
		await reopened.harness.close(context);
	});
});

/** A stream whose final message is not strict JSON, so the classification commit throws and the task faults. */
function invalidFinalStream(): ReturnType<Models["streamSimple"]> {
	const events = async function* () {
		yield { type: "start", partial: fauxAssistantMessage("partial", { stopReason: "pending" }) };
		await new Promise((resolve) => setTimeout(resolve, 300));
	};
	const final = { ...fauxAssistantMessage("final"), invalid: () => {} };
	return { [Symbol.asyncIterator]: events, result: async () => final } as unknown as ReturnType<
		Models["streamSimple"]
	>;
}

// ─── Review follow-ups ──────────────────────────────────────────────────────

/** A waiter of its own kind, so its definition can be removed or replaced. */
function versioned(version: 1 | 2) {
	return defineTask<{ on: TaskId[] }, { phase: "wait" } | { phase: "resume" } | { phase: "migrated" }, string>({
		name: "test.versioned",
		version,
		initial: () => ({ phase: "wait" }),
		phases: {
			wait: (task, runtime, ctx) =>
				runtime.commit(
					() => ({ status: "waiting", checkpoint: { phase: "resume" }, on: task.input.on, policy: "allSettled" }),
					ctx,
				),
			resume: (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "v1" } }), ctx),
			migrated: (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "v2" } }), ctx),
		},
		abort: (_task, runtime, ctx) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
		...(version === 2
			? {
					migrate: (input: unknown) => ({
						input: input as { on: TaskId[] },
						checkpoint: { phase: "migrated" as const },
					}),
				}
			: {}),
	});
}

/** Script `name` to spawn `child` and then complete, holding while the child lives. */
function spawnAndFinish(name: string, child: string): { id?: TaskId } {
	const found: { id?: TaskId } = {};
	script(name, {
		run: async (runtime, ctx) => {
			await runtime.commit(async (tx) => {
				found.id = await spawn(tx, runtime.taskId, child);
				return { status: "running", checkpoint: { phase: "resume", round: 1 } };
			}, ctx);
		},
	});
	return found;
}

describe("definitions and waits", () => {
	it("keeps a waiting task blocked without its definition and resumes it migrated under a newer one", async () => {
		const { harness, root, registry } = await openNodes();
		const registration = addTask(registry, versioned(1));
		const other = await start(root, "other");
		const waiter = await root.commit((tx) => tx.createTask(versioned(1), { on: [other] }, OWN_CONVERSATION), context);
		await until(async () => (await state(harness, waiter)).status === "waiting");
		registration.dispose();
		open("other");
		await harness.waitForTask(other, context);
		const inspected = async () =>
			(await harness.inspect(context)).tasks.find((task) => task.record.id === waiter)?.state;
		expect(await inspected()).toEqual({ kind: "blocked", reason: "missing_task" });
		expect((await state(harness, waiter)).status).toBe("waiting");
		addTask(registry, versioned(2));
		expect((await harness.waitForTask(waiter, context)).state.outcome).toEqual({ status: "completed", result: "v2" });
		await harness.close(context);
	});

	it("orphans an aborted waiting task without its definition at once, leaving the task it waits on running", async () => {
		const { harness, root, registry } = await openNodes();
		const registration = addTask(registry, versioned(1));
		const other = await start(root, "other");
		const waiter = await root.commit((tx) => tx.createTask(versioned(1), { on: [other] }, OWN_CONVERSATION), context);
		await until(async () => (await state(harness, waiter)).status === "waiting");
		registration.dispose();
		expect(await harness.abortTask(waiter, context)).toBe("marked");
		expect((await state(harness, waiter)).outcome).toEqual({ status: "orphaned", reason: "missing_task" });
		expect((await state(harness, other)).status).toBe("running");
		open("other");
		await harness.close(context);
	});

	it("never migrates a held outcome: a newer definition leaves it and its version alone", async () => {
		const { harness, root, registry, reports } = await openNodes();
		const holder = (version: number) =>
			defineTask<null, { phase: "run" }, string>({
				name: "test.holder",
				version,
				initial: () => ({ phase: "run" }),
				phases: {
					run: async (task, runtime, ctx) => {
						await runtime.commit(async (tx) => {
							await spawn(tx, task.id, "child");
							return undefined;
						}, ctx);
						await runtime.commit(
							() => ({ status: "terminal", outcome: { status: "completed", result: "held" } }),
							ctx,
						);
					},
				},
				abort: (_task, runtime, ctx) =>
					runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
				migrate: () => {
					throw new Error("never migrates");
				},
			});
		addTask(registry, holder(1));
		const parent = await root.commit((tx) => tx.createTask(holder(1), null, OWN_CONVERSATION), context);
		await until(async () => (await state(harness, parent)).status === "completing");
		// The same extension name replaces the old one in place.
		addTask(registry, holder(2));
		open("child");
		const settledParent = await harness.waitForTask(parent, context);
		expect(settledParent.state.outcome).toEqual({ status: "completed", result: "held" });
		expect(settledParent.version).toBe(1);
		expect(reports).toEqual([]);
		await harness.close(context);
	});

	it("treats a held task as live: outcomes() rejects, and a task waiting on it resumes at its final commit", async () => {
		const { harness, root } = await openNodes();
		spawnAndFinish("held", "child");
		const held = await start(root, "held");
		await until(async () => (await state(harness, held)).status === "completing");
		let rejection = "";
		script("reader", {
			run: async (runtime, ctx) => {
				rejection = await runtime.outcomes([held], ctx).then(
					() => "resolved",
					(error: Error) => error.message,
				);
				await runtime.commit(() => waitOn([held], "allSettled"), ctx);
			},
		});
		const reader = await start(root, "reader");
		await until(async () => (await state(harness, reader)).status === "waiting");
		expect(rejection).toBe(`Task ${held} is not terminal`);
		open("child");
		expect(await outcomeOf(harness, reader)).toBe("completed");
		expect(log.indexOf("resume:reader")).toBeGreaterThan(-1);
		await harness.close(context);
	});
});

describe("conversation abort and boundaries", () => {
	it("marks a held completed task with Conversation.abort(): the work below is aborted, the outcome stays", async () => {
		const { harness, root } = await openNodes();
		const child = spawnAndFinish("held", "child");
		const held = await start(root, "held");
		await until(async () => (await state(harness, held)).status === "completing");
		await root.abort(context);
		expect(await outcomeOf(harness, child.id!)).toBe("aborted");
		const record = await harness.waitForTask(held, context);
		expect(record.state.outcome.status).toBe("completed");
		expect(record.abortRequested).toBe(true);
		await harness.close(context);
	});

	it("marks and awaits only the background work reached when { background: true } is admitted", async () => {
		const { harness, root } = await openNodes();
		script("first", {
			abort: async (runtime, ctx) => {
				await gate("abort.first").promise;
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		const background = { ...OWN_CONVERSATION, background: true };
		const first = await start(root, "first", background);
		await until(() => log.includes("run:first"));
		const aborting = root.abort(context, { background: true });
		await until(async () => (await harness.getTask(first, context))!.abortRequested);
		const later = await start(root, "later", background);
		open("abort.first");
		await aborting;
		expect((await state(harness, later)).status).not.toBe("terminal");
		expect((await harness.getTask(later, context))!.abortRequested).toBe(false);
		await harness.abortTask(later, context);
		await harness.close(context);
	});

	it("stops a cascade at an unmarked background task, but not at a marked one", async () => {
		const { harness, root } = await openNodes();
		script("owner", {
			abort: async (runtime, ctx) => {
				await gate("abort.owner").promise;
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		const tree = await root.commit(async (tx) => {
			const owner = await tx.createTask(Node, { name: "owner" }, OWN_CONVERSATION);
			const outer = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
			const background = await tx.createTask(
				Node,
				{ name: "background" },
				{ ...OWN_CONVERSATION, conversationId: outer.id, background: true },
			);
			const inner = await tx.createConversation({ ownership: { kind: "task", taskId: background } });
			return { owner, outer: outer.id, background, inner: inner.id };
		}, context);
		await until(() => log.includes("run:owner") && log.includes("run:background"));
		// The owner's abort handler starts at once: background work is not its ordinary owned work.
		await harness.abortTask(tree.owner, context);
		await until(() => log.includes("abort:owner"));
		const inner = (await harness.conversation(tree.inner, context))!;
		const outer = (await harness.conversation(tree.outer, context))!;
		const shielded = await start(inner, "shielded");
		const exposed = await start(outer, "exposed");
		expect(await outcomeOf(harness, exposed)).toBe("aborted");
		expect((await harness.getTask(shielded, context))!.abortRequested).toBe(false);
		// Marked directly, the background task cascades into its own subtree.
		await harness.abortTask(tree.background, context);
		expect(await outcomeOf(harness, shielded)).toBe("aborted");
		expect(await outcomeOf(harness, tree.background)).toBe("aborted");
		open("abort.owner");
		expect(await outcomeOf(harness, tree.owner)).toBe("aborted");
		await harness.close(context);
	});

	it("fails the Harness on a failed finalization, which reopening applies", async () => {
		let reject: TaskId | undefined;
		const failure = new Error("disk gone");
		class Failing extends ControlledStorage {
			override async commit(
				writes: Parameters<MemoryStorage["commit"]>[0],
				ctx: Parameters<MemoryStorage["commit"]>[1],
			) {
				const finalizes = writes.some(
					(write) => write.type === "task" && write.value.id === reject && write.value.state.status === "terminal",
				);
				if (finalizes) {
					reject = undefined;
					throw failure;
				}
				return super.commit(writes, ctx);
			}
		}
		const storage = new Failing();
		const { harness, root, reports } = await openNodes(storage);
		spawnAndFinish("parent", "child");
		const parent = await start(root, "parent");
		await until(async () => (await state(harness, parent)).status === "completing");
		reject = parent;
		open("child");
		expect(await harness.closed).toEqual({ reason: "failed", error: failure });
		expect(reports).toEqual([failure]);
		await harness.close(context);
		const reopened = await openNodes(storage.reopen());
		expect(await outcomeOf(reopened.harness, parent)).toBe("completed");
		await reopened.harness.close(context);
	});
});

describe("recovery through ownership edges", () => {
	it("shows an abort-marked owner waiting for work in its owned conversation before resume after reopen", async () => {
		const path = await sqlitePath();
		const session = createSession(await openNodeSqliteStorage(path));
		const tree = await session.commit(async (tx) => {
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const owner = await tx.createTask(
				Node,
				{ name: "owner" },
				{ ...OWN_CONVERSATION, conversationId: conversation.id },
			);
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
			const inner = await tx.createTask(Node, { name: "inner" }, { ...OWN_CONVERSATION, conversationId: child.id });
			return { owner, inner };
		}, context);
		await session.commit(async (tx) => {
			const record = (await tx.task(tree.owner))!;
			(tx as unknown as { setTask(value: unknown): void }).setTask({ ...record, abortRequested: true });
		}, context);
		await session.close(context);

		const { harness } = await openTasks(await openNodeSqliteStorage(path), [Node]);
		const inspected = (await harness.inspect(context)).tasks.find((task) => task.record.id === tree.owner);
		expect(inspected?.state).toEqual({ kind: "waiting", on: [tree.inner] });
		harness.resume();
		expect(await outcomeOf(harness, tree.owner)).toBe("aborted");
		expect(log.filter((line) => line.startsWith("abort:"))).toEqual(["abort:inner", "abort:owner"]);
		await harness.close(context);
	});

	it("keeps the root busy after reopen for work below a child task's owned conversation", async () => {
		const path = await sqlitePath();
		let inner: TaskId | undefined;
		script("child", {
			run: async (runtime, ctx) => {
				await runtime.commit(async (tx) => {
					const conversation = await tx.createConversation({
						ownership: { kind: "task", taskId: runtime.taskId },
					});
					inner = await tx.createTask(
						Node,
						{ name: "inner" },
						{ ...OWN_CONVERSATION, conversationId: conversation.id },
					);
					return { status: "running", checkpoint: { phase: "resume", round: 1 } };
				}, ctx);
			},
		});
		parentOf("parent", ["child"], "allSettled");
		let opened = await openNodes(await openNodeSqliteStorage(path));
		const parent = await start(opened.root, "parent");
		await until(() => log.includes("run:inner"));
		await opened.harness.close(context);

		opened = await openNodes(await openNodeSqliteStorage(path));
		expect(await settled(opened.root.waitForIdle(context))).toBe(false);
		open("inner");
		await opened.root.waitForIdle(context);
		expect(await outcomeOf(opened.harness, parent)).toBe("completed");
		expect(inner).toBeDefined();
		await opened.harness.close(context);
	});

	it("keeps a finished background ancestor a boundary after reopen, which { background: true } crosses", async () => {
		const path = await sqlitePath();
		let conversation: ConversationId | undefined;
		script("child", {
			run: async (runtime, ctx) => {
				await runtime.commit(async (tx) => {
					conversation = (await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } })).id;
					return { status: "running", checkpoint: { phase: "resume", round: 1 } };
				}, ctx);
			},
		});
		parentOf("background", ["child"], "allSettled");
		let opened = await openNodes(await openNodeSqliteStorage(path));
		const background = await start(opened.root, "background", { ...OWN_CONVERSATION, background: true });
		await opened.harness.waitForTask(background, context);
		await opened.harness.close(context);

		opened = await openNodes(await openNodeSqliteStorage(path));
		const below = await start((await opened.harness.conversation(conversation!, context))!, "below");
		await until(() => log.includes("run:below"));
		await opened.root.waitForIdle(context);
		await opened.root.abort(context);
		expect((await state(opened.harness, below)).status).toBe("running");
		await opened.root.abort(context, { background: true });
		expect(await outcomeOf(opened.harness, below)).toBe("aborted");
		await opened.harness.close(context);
	});
});

describe("tool rounds and events", () => {
	async function listen(harness: Harness, conversation: Conversation) {
		const stream = await watchEvents(harness, conversation.id, context);
		const events: AgentEvent[] = [];
		stream.start(async (batch) => {
			events.push(...batch);
		});
		return { stream, events };
	}

	/** Event types, with tool ends and message ends labelled by call ID and whether an entry came along. */
	function labels(events: readonly AgentEvent[]): string[] {
		return events.flatMap((event) => {
			if (event.type === "tool_execution_end") return [`end:${event.toolCallId}:${event.entry !== undefined}`];
			if (event.type === "message_end") {
				const message = event.entry.model?.[0];
				return [message?.role === "toolResult" ? `result:${message.toolCallId}` : `message:${message?.role}`];
			}
			return [];
		});
	}

	it("ends an aborted sequential round's unstarted calls with their result entries, right before them", async () => {
		const setup = chatSetup();
		const one = blockingTool("one");
		addTool(setup.registry, one.registration);
		addTool(setup.registry, defineTool({ ...blockingTool("two").registration, name: "two" }));
		setup.faux.setResponses([toolCalls(["one", "c1"], ["two", "c2"], ["two", "c3"])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const { stream, events } = await listen(harness, root);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await one.started;
		await harness.abortTask((await harness.snapshot(LiveDoc, root.id, context))!.run!.taskId, context);
		await submission.wait(context);
		await waitFor(() => labels(events).includes("result:c3"));
		expect(labels(events).filter((label) => !label.startsWith("message:"))).toEqual([
			"end:c1:true",
			"result:c1",
			"end:c2:true",
			"result:c2",
			"end:c3:true",
			"result:c3",
		]);
		await stream.stop();
		await harness.close(context);
	});

	it("emits one turn_end per generation, also for a stream attached while it holds", async () => {
		const setup = chatSetup();
		addTask(setup.registry, Node);
		addTool(
			setup.registry,
			defineTool({
				name: "noop",
				description: "Does nothing",
				parameters: Type.Object({}),
				execute: async () => ({ output: [] }),
			}),
		);
		let opened: Harness | undefined;
		addHooks(setup.registry, GenerationTask, {
			afterTools: async (_assistant, _results, api, callContext) => {
				await opened!.commit((tx) => tx.createTask(Node, { name: "hooked" }, owned(api.taskId)), callContext);
			},
		});
		setup.faux.setResponses([toolCalls(["noop", "c1"]), fauxAssistantMessage([fauxText("done")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		opened = harness;
		const early = await listen(harness, root);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const late = await listen(harness, root);
		open("hooked");
		const [first] = (await harness.commit((tx) => tx.scanTasks({ kind: "pi.generation" }, 1), context)).items;
		await harness.waitForTask(first!.id, context);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		await waitFor(() => late.events.some((event) => event.type === "entry_appended"));
		const turns = (events: readonly AgentEvent[]) => events.filter((event) => event.type === "turn_end").length;
		expect(turns(early.events)).toBe(2);
		expect(turns(late.events)).toBe(0);
		await early.stream.stop();
		await late.stream.stop();
		await harness.close(context);
	});

	it("lets a tool that owns live work finish its call at the hold while the generation waits for its final commit", async () => {
		const setup = chatSetup();
		addTask(setup.registry, Node);
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Starts work in a conversation it owns",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					await api.commit(async (tx) => {
						const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await tx.createTask(Node, { name: "sub" }, { ...OWN_CONVERSATION, conversationId: child.id });
					}, callContext);
					return { output: [{ type: "text", text: "started" }] };
				},
			}),
		);
		setup.faux.setResponses([toolCalls(["delegate", "c1"]), fauxAssistantMessage([fauxText("done")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const { stream, events } = await listen(harness, root);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await waitFor(async () => (await harness.snapshot(LiveDoc, root.id, context))?.tools?.[0]?.status === "done");
		const live = (await harness.snapshot(LiveDoc, root.id, context))!;
		const tool = live.tools![0]!.taskId!;
		expect(live.tools![0]!.entry).toBeDefined();
		expect((await state(harness, tool)).status).toBe("completing");
		expect((await state(harness, live.run!.taskId)).status).toBe("waiting");
		await waitFor(() => labels(events).includes("end:c1:true"));
		expect(await settled(submission.wait(context))).toBe(false);
		open("sub");
		expect((await submission.wait(context)).status).toBe("done");
		expect(await outcomeOf(harness, tool)).toBe("completed");
		await stream.stop();
		await harness.close(context);
	});

	it("holds a faulted tool's slot and task_failed until the work it owns drained", async () => {
		const setup = chatSetup();
		addTask(setup.registry, Node);
		script("held", {
			abort: async (runtime, ctx) => {
				await gate("abort.held").promise;
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		addTool(
			setup.registry,
			defineTool({
				name: "broken",
				description: "Starts owned work, then returns a result that is not strict JSON",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					await api.commit((tx) => tx.createTask(Node, { name: "held" }, owned(api.taskId)), callContext);
					return { output: [], details: { fn: (() => 1) as unknown as JsonValue } };
				},
			}),
		);
		setup.faux.setResponses([toolCalls(["broken", "c1"]), fauxAssistantMessage([fauxText("done")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const { stream, events } = await listen(harness, root);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await waitFor(() => log.includes("abort:held"));
		const live = (await harness.snapshot(LiveDoc, root.id, context))!;
		const tool = live.tools![0]!.taskId!;
		expect(await state(harness, tool)).toMatchObject({ status: "completing", outcome: { status: "faulted" } });
		expect(live.tools![0]!.status).not.toBe("done");
		expect(events.some((event) => event.type === "task_failed")).toBe(false);
		open("abort.held");
		expect((await submission.wait(context)).status).toBe("done");
		expect(await outcomeOf(harness, tool)).toBe("faulted");
		await waitFor(() => events.some((event) => event.type === "task_failed"));
		expect(labels(events)).toContain("end:c1:false");
		await stream.stop();
		await harness.close(context);
	});
});
