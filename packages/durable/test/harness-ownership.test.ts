import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationHandle,
	type ConversationId,
	configure,
	createSession,
	defineDoc,
	defineTask,
	defineTool,
	type EntryId,
	type Harness,
	LiveDoc,
	MemoryStorage,
	type Storage,
	type Submission,
	type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { chatSetup, openChat } from "./chat-support.ts";
import { addTask, addTool } from "./harness-support.ts";
import { ControlledStorage, context } from "./session-support.ts";
import { aborted, type Deferred, deferred, openTasks, settled } from "./task-support.ts";

/** Outcome a held task commits once its gate opens. */
type Ending = "completed" | "failed";
const gates = new Map<string, Deferred<Ending>>();

function gate(name: string): Deferred<Ending> {
	let found = gates.get(name);
	if (found === undefined) {
		found = deferred<Ending>();
		gates.set(name, found);
	}
	return found;
}

/** How often each named task started its run phase. */
const runs = new Map<string, number>();

/**
 * A task that holds until its named gate opens or it is aborted. With `slowAbort`, its abort handler first waits for
 * the gate `abort.<name>`.
 */
const Hold = defineTask<{ name: string; slowAbort?: boolean }, { phase: "hold" }, null>({
	name: "test.hold",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: {
		hold: async (task, runtime, ctx) => {
			runs.set(task.input.name, (runs.get(task.input.name) ?? 0) + 1);
			const ending = await Promise.race([gate(task.input.name).promise, aborted(runtime.signal)]);
			await runtime.commit(
				() =>
					ending === "completed"
						? { status: "terminal", outcome: { status: "completed", result: null } }
						: { status: "terminal", outcome: { status: "failed", error: { message: "gate failed" } } },
				ctx,
			);
		},
	},
	abort: async (task, runtime, ctx) => {
		if (task.input.slowAbort === true) await gate(`abort.${task.input.name}`).promise;
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
	},
});

/** Waits on the tasks in its input, then completes; its abort handler ends it `aborted`. */
const Waiter = defineTask<{ on: TaskId[] }, { phase: "wait" } | { phase: "done" }, null>({
	name: "test.waiter",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: async (task, runtime, ctx) => {
			const checkpoint = { phase: "done" } as const;
			await runtime.commit(() => ({ status: "waiting", checkpoint, on: task.input.on, policy: "allSettled" }), ctx);
		},
		done: async (_task, runtime, ctx) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/** Tries to create, in the commit that ends it, a conversation it owns with a held task in it, named by its input. */
const Spawner = defineTask<{ name: string }, { phase: "spawn" }, null>({
	name: "test.spawner",
	version: 1,
	initial: () => ({ phase: "spawn" }),
	phases: {
		spawn: async (task, runtime, ctx) =>
			runtime.commit(async (tx) => {
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
				await tx.createTask(
					Hold,
					{ name: task.input.name },
					{ ownership: { kind: "conversation" }, conversationId: child.id },
				);
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, ctx),
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/** Never registered: aborting it can only orphan it. */
const Unregistered = defineTask<{ name: string }, { phase: "hold" }, null>({
	name: "test.unregistered",
	version: 1,
	initial: () => ({ phase: "hold" }),
	phases: { hold: async () => {} },
	abort: async () => {},
});

function open(name: string, ending: Ending): void {
	gate(name).resolve(ending);
}

const directories = new Set<string>();
afterEach(async () => {
	gates.clear();
	runs.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

type Tree = { owner: TaskId; child: ConversationId; inner: TaskId };

/** In `parent`, stage task `owner` and a conversation it owns holding task `inner`, in one commit. */
async function ownedChild(
	parent: Conversation,
	name: string,
	options: { background?: boolean; slowInner?: boolean; slowOwner?: boolean } = {},
): Promise<Tree> {
	return parent.commit(async (tx) => {
		const owner = await tx.createTask(
			Hold,
			{ name, ...(options.slowOwner === true ? { slowAbort: true } : {}) },
			{ ownership: { kind: "conversation" }, background: options.background ?? false },
		);
		const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
		const inner = await tx.createTask(
			Hold,
			{ name: `${name}.inner`, ...(options.slowInner === true ? { slowAbort: true } : {}) },
			{ ownership: { kind: "conversation" }, conversationId: child.id },
		);
		return { owner, child: child.id, inner };
	}, context);
}

/** A faux response held until `release` or cancellation; `reached` resolves when the request is sent. */
function gated(message: AssistantMessage) {
	const reached = deferred();
	const gate = deferred();
	const step = async (_request: unknown, options?: { signal?: AbortSignal }) => {
		reached.resolve();
		await Promise.race([gate.promise, aborted(options!.signal!)]);
		return message;
	};
	return { step, reached: reached.promise, release: () => gate.resolve() };
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 500 && !(await check()); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	if (!(await check())) throw new Error("Condition was not reached");
}

/** Mark a conversation busy with `task` standing in for its run, so submissions queue. */
async function busy(conversation: Conversation, task: TaskId): Promise<void> {
	await conversation.commit(async (tx) => {
		(await tx.doc(LiveDoc, conversation.id)).run = { taskId: task, inputs: [], turns: 0 };
	}, context);
}

async function status(harness: Harness, id: TaskId) {
	return (await harness.getTask(id, context))!.state;
}

/** A write that affects model context, so it queues while busy; a data-only write would be appended at once. */
function queuedNote(text: string) {
	return { kind: "note", model: [{ role: "user", content: text, timestamp: 0 }] } as const;
}

async function openHarness(storage: Storage = new MemoryStorage()) {
	const opened = await openTasks(storage, [Hold, Waiter, Spawner]);
	const root = await opened.harness.root(context);
	opened.harness.resume();
	return { ...opened, root };
}

describe("ownership", () => {
	it("keeps a conversation busy while its owned foreground subtree has live work, holding the completed owner", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner");
		open("owner", "completed");
		await waitUntil(async () => (await status(harness, tree.owner)).status === "completing");
		const idle = root.waitForIdle(context);
		expect(await settled(idle)).toBe(false);
		expect(await settled(harness.waitForIdle(context))).toBe(false);
		open("owner.inner", "completed");
		await idle;
		await harness.waitForIdle(context);
		expect((await status(harness, tree.owner)).outcome?.status).toBe("completed");
		await harness.close(context);
	});

	it("holds an owner for work in a conversation its ended child task owns", async () => {
		const { harness, root } = await openHarness();
		const { owner, child, conversation } = await root.commit(async (tx) => {
			const owner = await tx.createTask(Hold, { name: "owner" }, { ownership: { kind: "conversation" } });
			const child = await tx.createTask(Hold, { name: "child" }, { ownership: { kind: "task", taskId: owner } });
			const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: child } });
			return { owner, child, conversation: conversation.id };
		}, context);
		open("child", "completed");
		expect((await harness.waitForTask(child, context)).state.outcome.status).toBe("completed");
		// The ended child's conversation still belongs to the owner above it.
		const handle = (await harness.conversation(conversation, context))!;
		await handle.commit(
			(tx) => tx.createTask(Hold, { name: "late" }, { ownership: { kind: "conversation" } }),
			context,
		);
		open("owner", "completed");
		await waitUntil(async () => (await status(harness, owner)).status === "completing");
		open("late", "completed");
		expect((await harness.waitForTask(owner, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	});

	it("cascades through ended tasks into an owned background subtree when aborting across background", async () => {
		const { harness, root } = await openHarness();
		// root conversation -> A -> B -> conversation -> background C -> D
		const tree = await root.commit(async (tx) => {
			const a = await tx.createTask(Hold, { name: "a" }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: a } });
			const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: b } });
			const c = await tx.createTask(
				Hold,
				{ name: "c" },
				{ ownership: { kind: "conversation" }, conversationId: conversation.id, background: true },
			);
			const d = await tx.createTask(Hold, { name: "d" }, { ownership: { kind: "task", taskId: c } });
			return { a, b, c, d };
		}, context);
		open("b", "completed");
		open("a", "completed");
		expect((await harness.waitForTask(tree.a, context)).state.outcome.status).toBe("completed");
		await root.abort(context, { background: true });
		for (const id of [tree.c, tree.d]) {
			expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("aborted");
		}
		await harness.close(context);
	});

	it("keeps ownership queries off finished subtrees", async () => {
		const { harness, root } = await openHarness();
		// Ended chains under a live owner, each ending in an empty owned conversation.
		const owner = await root.commit(
			(tx) => tx.createTask(Hold, { name: "owner" }, { ownership: { kind: "conversation" } }),
			context,
		);
		const chains = 50;
		const tasks: TaskId[] = [];
		for (let n = 0; n < chains; n++) {
			const ids = await root.commit(async (tx) => {
				const first = await tx.createTask(
					Hold,
					{ name: `c${n}.0` },
					{ ownership: { kind: "task", taskId: owner } },
				);
				const second = await tx.createTask(
					Hold,
					{ name: `c${n}.1` },
					{ ownership: { kind: "task", taskId: first } },
				);
				await tx.createConversation({ ownership: { kind: "task", taskId: second } });
				return [first, second];
			}, context);
			tasks.push(...ids);
		}
		for (let n = 0; n < chains; n++) {
			open(`c${n}.1`, "completed");
			open(`c${n}.0`, "completed");
		}
		for (const id of tasks) await harness.waitForTask(id, context);
		// Set iterations while the owner settles, a measure of the walks down: one through every ended task iterates
		// hundreds of entries; one over live work alone, none below the owner.
		const values = Set.prototype.values;
		const iterator = Set.prototype[Symbol.iterator];
		let entries = 0;
		function* counted(this: Set<unknown>) {
			for (const value of values.call(this)) {
				entries++;
				yield value;
			}
		}
		Set.prototype[Symbol.iterator] = counted as unknown as typeof iterator;
		try {
			open("owner", "completed");
			expect((await harness.waitForTask(owner, context)).state.outcome.status).toBe("completed");
		} finally {
			Set.prototype[Symbol.iterator] = iterator;
		}
		expect(entries).toBeLessThan(chains);
		await harness.close(context);
	});

	it("tracks ownership chains deeper than the call stack", async () => {
		const { harness, root } = await openHarness();
		// 20,000 tasks, each owning the next, created in one commit above a live leaf; they end top-down and hold.
		const depth = 20_000;
		const { top, leaf } = await root.commit(async (tx) => {
			const top = await tx.createTask(Hold, { name: "top" }, { ownership: { kind: "conversation" } });
			let owner = top;
			for (let n = 0; n < depth; n++) {
				owner = await tx.createTask(Hold, { name: `link${n}` }, { ownership: { kind: "task", taskId: owner } });
			}
			const leaf = await tx.createTask(Hold, { name: "leaf" }, { ownership: { kind: "task", taskId: owner } });
			return { top, leaf };
		}, context);
		for (let n = 0; n < depth; n++) open(`link${n}`, "completed");
		open("top", "completed");
		await waitUntil(async () => (await status(harness, top)).status === "completing");
		open("leaf", "completed");
		expect((await harness.waitForTask(leaf, context)).state.outcome.status).toBe("completed");
		expect((await harness.waitForTask(top, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	}, 60_000);

	it("holds an owner for work a commit creates below ended tasks loaded from storage", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-ownership-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		let opened = await openHarness(await openNodeSqliteStorage(path));
		// Live P owns B, which owns A, which owns the empty conversation C; B and A end.
		const tree = await opened.root.commit(async (tx) => {
			const p = await tx.createTask(Hold, { name: "p" }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const a = await tx.createTask(Hold, { name: "a" }, { ownership: { kind: "task", taskId: b } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: a } });
			return { p, a, b, c: c.id };
		}, context);
		open("a", "completed");
		open("b", "completed");
		await opened.harness.waitForTask(tree.a, context);
		await opened.harness.waitForTask(tree.b, context);
		await opened.harness.close(context);
		// After reopen, B and A are known only once a chain load reads them.
		opened = await openHarness(await openNodeSqliteStorage(path));
		const c = (await opened.harness.conversation(tree.c, context))!;
		const d = await c.commit(
			(tx) => tx.createTask(Hold, { name: "d" }, { ownership: { kind: "conversation" } }),
			context,
		);
		open("p", "completed");
		await waitUntil(async () => (await status(opened.harness, tree.p)).status === "completing");
		open("d", "completed");
		expect((await opened.harness.waitForTask(d, context)).state.outcome.status).toBe("completed");
		expect((await opened.harness.waitForTask(tree.p, context)).state.outcome.status).toBe("completed");
		await opened.harness.close(context);
	});

	it("holds an owner for work created later below ended tasks, without a reopen", async () => {
		const { harness, root } = await openHarness();
		// Live P owns B, which owns A, which owns the empty conversation C; B and A end, C stays.
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Hold, { name: "p" }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const a = await tx.createTask(Hold, { name: "a" }, { ownership: { kind: "task", taskId: b } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: a } });
			return { p, a, b, c: c.id };
		}, context);
		open("a", "completed");
		open("b", "completed");
		await harness.waitForTask(tree.b, context);
		const c = (await harness.conversation(tree.c, context))!;
		const d = await c.commit(
			(tx) => tx.createTask(Hold, { name: "d" }, { ownership: { kind: "conversation" } }),
			context,
		);
		open("p", "completed");
		await waitUntil(async () => (await status(harness, tree.p)).status === "completing");
		open("d", "completed");
		expect((await harness.waitForTask(d, context)).state.outcome.status).toBe("completed");
		expect((await harness.waitForTask(tree.p, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	});

	// Live P owns `depth` ended tasks in a chain, the last owning conversation C, empty when they ended. Work started in C
	// later is still P's: every case below must reach it through the ended tasks.
	async function endedBridge(depth: number) {
		const { harness, root } = await openHarness();
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Hold, { name: "p", slowAbort: true }, { ownership: { kind: "conversation" } });
			const links: TaskId[] = [];
			let owner = p;
			for (let n = 0; n < depth; n++) {
				owner = await tx.createTask(Hold, { name: `link${n}` }, { ownership: { kind: "task", taskId: owner } });
				links.push(owner);
			}
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
			return { p, links, c: c.id };
		}, context);
		for (let n = depth - 1; n >= 0; n--) open(`link${n}`, "completed");
		for (const id of tree.links) await harness.waitForTask(id, context);
		const c = (await harness.conversation(tree.c, context))!;
		const create = (name: string) =>
			c.commit((tx) => tx.createTask(Hold, { name }, { ownership: { kind: "conversation" } }), context);
		return { harness, root, p: tree.p, create };
	}

	for (const depth of [2, 5]) {
		it(`aborts work below ${depth} ended tasks with their live owner, which waits for it`, async () => {
			const { harness, p, create } = await endedBridge(depth);
			const d = await create("d");
			await harness.abortTask(p, context);
			expect((await harness.waitForTask(d, context)).state.outcome.status).toBe("aborted");
			// P's abort handler ran only after D ended.
			open("abort.p", "completed");
			expect((await harness.waitForTask(p, context)).state.outcome.status).toBe("aborted");
			await harness.close(context);
		});

		it(`keeps the root busy and aborts with it work below ${depth} ended tasks`, async () => {
			const { harness, root, p, create } = await endedBridge(depth);
			open("p", "completed");
			await harness.waitForTask(p, context);
			// P has ended: D and D2 hang below ended tasks only, and are still the root conversation's work.
			const d = await create("d");
			const d2 = await create("d2");
			expect(await settled(root.waitForIdle(context))).toBe(false);
			expect(await settled(harness.waitForIdle(context))).toBe(false);
			await root.abort(context);
			for (const id of [d, d2])
				expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("aborted");
			await harness.close(context);
		});
	}

	it("reaches work below ended tasks across two owned conversations", async () => {
		const { harness, root } = await openHarness();
		// Live P -> ended B -> conversation C -> ended X -> ended A -> conversation C2; work starts in C2 later. X owns no
		// conversation, only the task A, so only owning a known task keeps it.
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Hold, { name: "p" }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: b } });
			const x = await tx.createTask(
				Hold,
				{ name: "x" },
				{ ownership: { kind: "conversation" }, conversationId: c.id },
			);
			const a = await tx.createTask(Hold, { name: "a" }, { ownership: { kind: "task", taskId: x } });
			const c2 = await tx.createConversation({ ownership: { kind: "task", taskId: a } });
			return { p, b, x, c2: c2.id };
		}, context);
		open("a", "completed");
		open("x", "completed");
		open("b", "completed");
		await harness.waitForTask(tree.b, context);
		const c2 = (await harness.conversation(tree.c2, context))!;
		const d = await c2.commit(
			(tx) => tx.createTask(Hold, { name: "d" }, { ownership: { kind: "conversation" } }),
			context,
		);
		open("p", "completed");
		await waitUntil(async () => (await status(harness, tree.p)).status === "completing");
		expect(await settled(root.waitForIdle(context))).toBe(false);
		await root.abort(context);
		expect((await harness.waitForTask(d, context)).state.outcome.status).toBe("aborted");
		expect((await harness.waitForTask(tree.p, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	});

	for (const ending of ["completes", "is aborted"] as const) {
		it(`frees an owner that ${ending} once the last work below ended tasks ends after a background task there`, async () => {
			const { harness, root } = await openHarness();
			// Live P owns B, which owns A, which owns conversation C with background Z and, later, foreground D.
			const tree = await root.commit(async (tx) => {
				const p = await tx.createTask(Hold, { name: "p" }, { ownership: { kind: "conversation" } });
				const b = await tx.createTask(Hold, { name: "b" }, { ownership: { kind: "task", taskId: p } });
				const a = await tx.createTask(Hold, { name: "a" }, { ownership: { kind: "task", taskId: b } });
				const c = await tx.createConversation({ ownership: { kind: "task", taskId: a } });
				const z = await tx.createTask(
					Hold,
					{ name: "z" },
					{ ownership: { kind: "conversation" }, conversationId: c.id, background: true },
				);
				return { p, a, b, c: c.id, z };
			}, context);
			open("a", "completed");
			open("b", "completed");
			await harness.waitForTask(tree.b, context);
			const c = (await harness.conversation(tree.c, context))!;
			const d = await c.commit(
				(tx) => tx.createTask(Hold, { name: "d", slowAbort: true }, { ownership: { kind: "conversation" } }),
				context,
			);
			if (ending === "completes") {
				open("p", "completed");
				await waitUntil(async () => (await status(harness, tree.p)).status === "completing");
			} else {
				// P waits for D's abort before its own abort handler runs.
				await harness.abortTask(tree.p, context);
				await waitUntil(async () => (await harness.getTask(d, context))!.abortRequested);
			}
			// Z ends first, D last.
			open("z", "completed");
			await harness.waitForTask(tree.z, context);
			if (ending === "completes") open("d", "completed");
			else open("abort.d", "completed");
			await harness.waitForTask(d, context);
			const expected = ending === "completes" ? "completed" : "aborted";
			expect((await harness.waitForTask(tree.p, context)).state.outcome.status).toBe(expected);
			await harness.close(context);
		});
	}

	it("finalizes many held siblings that end together in one pass", async () => {
		const { harness, root } = await openHarness();
		// Top holds 1000 held children, each holding one live leaf; the leaves end in one commit.
		const count = 1000;
		const { top, leaves } = await root.commit(async (tx) => {
			const top = await tx.createTask(Hold, { name: "top" }, { ownership: { kind: "conversation" } });
			const siblings: TaskId[] = [];
			for (let n = 0; n < count; n++) {
				siblings.push(await tx.createTask(Hold, { name: `s${n}` }, { ownership: { kind: "task", taskId: top } }));
			}
			// Leaves in reverse sibling order: the last sibling is freed first, so a holder checked after each freed sibling
			// would scan the siblings already finalized each time.
			const leaves: TaskId[] = [];
			for (let n = count - 1; n >= 0; n--) {
				const owner = siblings[n]!;
				leaves.push(await tx.createTask(Hold, { name: `l${n}` }, { ownership: { kind: "task", taskId: owner } }));
			}
			return { top, leaves };
		}, context);
		for (let n = 0; n < count; n++) open(`s${n}`, "completed");
		open("top", "completed");
		await waitUntil(async () => (await status(harness, top)).status === "completing");
		await root.commit(async (tx) => {
			// Reads before the first write. Ended last to first, so a holder checked after each sibling would scan the ones
			// already finalized every time.
			const records = [];
			for (const id of leaves) records.push((await tx.task(id))!);
			for (const record of records) {
				(tx as unknown as { setTask(value: unknown): void }).setTask({
					...record,
					state: { status: "terminal", outcome: { status: "completed", result: null } },
				});
			}
		}, context);
		// Set entries iterated while it all finalizes: one pass is linear, a recheck per sibling quadratic (~500,000).
		const iterator = Set.prototype[Symbol.iterator];
		const values = Set.prototype.values;
		let entries = 0;
		function* counted(this: Set<unknown>) {
			for (const value of values.call(this)) {
				entries++;
				yield value;
			}
		}
		Set.prototype[Symbol.iterator] = counted as unknown as typeof iterator;
		try {
			expect((await harness.waitForTask(top, context)).state.outcome.status).toBe("completed");
		} finally {
			Set.prototype[Symbol.iterator] = iterator;
		}
		expect(entries).toBeLessThan(count * 20);
		await harness.close(context);
	});

	// Pins the Transaction rule that a conversation cannot be created in the commit that ends its owner task.
	it("rejects a conversation created in the commit that ends its owner task", async () => {
		const { harness, root } = await openHarness();
		const spawner = await root.commit(
			(tx) => tx.createTask(Spawner, { name: "spawned" }, { ownership: { kind: "conversation" } }),
			context,
		);
		expect((await harness.waitForTask(spawner, context)).state.outcome).toEqual({
			status: "faulted",
			error: {
				message: expect.stringMatching(new RegExp(`^Conversation owner task ${spawner} is (completing|terminal)$`)),
			},
		});
		await harness.close(context);
	});

	it("stops idle traversal at a background owner", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "background", { background: true });
		await root.waitForIdle(context);
		await harness.waitForIdle(context);
		// The background child is its own scope.
		const child = (await harness.conversation(tree.child, context))!;
		expect(await settled(child.waitForIdle(context))).toBe(false);
		await child.abort(context);
		await harness.close(context);
	});

	it("cascades an abort mark to the owned foreground subtree and withdraws its queued inputs", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner");
		const nested = await harness.conversation(tree.child, context);
		const deeper = await ownedChild(nested!, "deeper");
		const shielded = await ownedChild(nested!, "shielded", { background: true });
		// Busy conversations queue submissions; the inner task stands in for the child's run.
		await busy(nested!, tree.inner);
		const queued = (await nested!.submit({ type: "input", content: "later" }, context)).id;
		expect(await harness.abortTask(tree.owner, context)).toBe("marked");
		for (const id of [tree.owner, tree.inner, deeper.owner, deeper.inner]) {
			expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("aborted");
		}
		// A nested background owner is a boundary.
		expect((await status(harness, shielded.owner)).status).not.toBe("terminal");
		expect((await status(harness, shielded.inner)).status).not.toBe("terminal");
		expect(await (await harness.submission(queued, context))!.status(context)).toMatchObject({
			status: "unanswered",
			reason: "aborted",
		});
		await harness.abortTask(shielded.owner, context);
		await harness.close(context);
	});

	it("cascades a failed owner but not a completed one", async () => {
		const { harness, root } = await openHarness();
		const failed = await ownedChild(root, "failed");
		const completedTree = await ownedChild(root, "done");
		open("failed", "failed");
		open("done", "completed");
		expect((await harness.waitForTask(failed.inner, context)).state.outcome.status).toBe("aborted");
		expect((await harness.waitForTask(failed.owner, context)).state.outcome.status).toBe("failed");
		await waitUntil(async () => (await status(harness, completedTree.owner)).status === "completing");
		expect((await status(harness, completedTree.inner)).status).not.toBe("terminal");
		open("done.inner", "completed");
		expect((await harness.waitForTask(completedTree.owner, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	});

	it("aborts a background task directly with its ordinary subtree", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "background", { background: true });
		await harness.abortTask(tree.owner, context);
		expect((await harness.waitForTask(tree.inner, context)).state.outcome.status).toBe("aborted");
		await harness.close(context);
	});

	it("aborts a conversation: queued inputs withdrawn, writes kept, foreground work aborted, background kept", async () => {
		const { harness, root } = await openHarness();
		const foreground = await ownedChild(root, "foreground");
		const background = await ownedChild(root, "background", { background: true });
		await busy(root, foreground.owner);
		const input = (await root.submit({ type: "input", content: "later" }, context)).id;
		const write = (await root.submit({ type: "write", entry: queuedNote("w") }, context)).id;
		await root.abort(context);
		for (const id of [foreground.owner, foreground.inner]) {
			expect((await status(harness, id)).status).toBe("terminal");
		}
		expect((await status(harness, background.owner)).status).not.toBe("terminal");
		expect((await status(harness, background.inner)).status).not.toBe("terminal");
		expect(await (await harness.submission(input, context))!.status(context)).toMatchObject({ reason: "aborted" });
		expect((await (await harness.submission(write, context))!.status(context)).status).toBe("queued");
		await harness.abortTask(background.owner, context);
		await harness.close(context);
	});

	it("aborts work created below a held failed owner, but not below a terminal one", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner", { slowInner: true });
		open("owner", "failed");
		await waitUntil(async () => (await harness.getTask(tree.inner, context))!.abortRequested);
		expect((await status(harness, tree.owner)).status).toBe("completing");
		const child = (await harness.conversation(tree.child, context))!;
		const create = (name: string) =>
			child.commit((tx) => tx.createTask(Hold, { name }, { ownership: { kind: "conversation" } }), context);
		const during = await create("during");
		expect((await harness.waitForTask(during, context)).state.outcome.status).toBe("aborted");
		open("abort.owner.inner", "completed");
		expect((await harness.waitForTask(tree.owner, context)).state.outcome.status).toBe("failed");
		// A terminal owner never cascades: interrogating its conversation runs normally.
		const after = await create("after");
		open("after", "completed");
		expect((await harness.waitForTask(after, context)).state.outcome.status).toBe("completed");
		await harness.close(context);
	});

	it("withdraws queued inputs below the aborted task but keeps its own conversation's queue and queued writes", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner");
		const child = (await harness.conversation(tree.child, context))!;
		await busy(root, tree.owner);
		await busy(child, tree.inner);
		const own = (await root.submit({ type: "input", content: "own" }, context)).id;
		const below = (await child.submit({ type: "input", content: "below" }, context)).id;
		const write = (await child.submit({ type: "write", entry: queuedNote("w") }, context)).id;
		await harness.abortTask(tree.owner, context);
		await harness.waitForTask(tree.inner, context);
		const statusOf = async (id: typeof own) =>
			(await (await harness.submission(id, context))!.status(context)).status;
		expect(await statusOf(own)).toBe("queued");
		expect(await statusOf(below)).toBe("unanswered");
		expect(await statusOf(write)).toBe("queued");
		await harness.close(context);
	});

	it("keeps a nested background owner's subtree when its cancelled background owner is aborted", async () => {
		const { harness, root } = await openHarness();
		const outer = await ownedChild(root, "outer", { background: true });
		const inner = await ownedChild((await harness.conversation(outer.child, context))!, "inner", {
			background: true,
		});
		await harness.abortTask(outer.owner, context);
		expect((await harness.waitForTask(outer.inner, context)).state.outcome.status).toBe("aborted");
		expect((await status(harness, inner.owner)).status).not.toBe("terminal");
		expect((await status(harness, inner.inner)).status).not.toBe("terminal");
		await harness.abortTask(inner.owner, context);
		await harness.close(context);
	});

	it("decides idle after reopen from owner edges it has to load first", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-ownership-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		let opened = await openHarness(await openNodeSqliteStorage(path));
		const foreground = await ownedChild(opened.root, "fg");
		const deeper = await ownedChild((await opened.harness.conversation(foreground.child, context))!, "fg2");
		const background = await ownedChild(opened.root, "bg", { background: true });
		open("fg", "completed");
		open("fg2", "completed");
		// Both owners hold their outcomes while the work below them runs.
		await waitUntil(async () => (await status(opened.harness, foreground.owner)).status === "completing");
		await waitUntil(async () => (await status(opened.harness, deeper.owner)).status === "completing");
		await opened.harness.close(context);

		opened = await openHarness(await openNodeSqliteStorage(path));
		// Two levels below completed foreground owners, the inner tasks keep the root busy.
		expect(await settled(opened.root.waitForIdle(context))).toBe(false);
		expect(await settled(opened.harness.waitForIdle(context))).toBe(false);
		open("fg.inner", "completed");
		open("fg2.inner", "completed");
		// The background subtree does not count.
		await opened.root.waitForIdle(context);
		await opened.harness.waitForIdle(context);
		expect((await status(opened.harness, foreground.owner)).status).toBe("terminal");
		expect((await status(opened.harness, background.inner)).status).not.toBe("terminal");
		await opened.harness.abortTask(background.owner, context);
		await opened.harness.close(context);
	});

	for (const [label, abortRequested, state] of [
		[
			"a held failed owner",
			false,
			{ status: "completing", outcome: { status: "failed", error: { message: "crash" } } },
		],
		["an abort-marked owner", true, { status: "pending", checkpoint: { phase: "hold" } }],
	] as const) {
		it(`derives marks a crash left unapplied below ${label} at open`, async () => {
			const directory = await mkdtemp(join(tmpdir(), "pi-durable-ownership-"));
			directories.add(directory);
			const path = join(directory, "session.sqlite");
			// Without a Harness, nothing derives marks: a cancelled owner with a live task below it.
			const session = createSession(await openNodeSqliteStorage(path));
			const tree = await session.commit(async (tx) => {
				const root = await tx.createConversation({ ownership: { kind: "ownerless" } });
				const owner = await tx.createTask(
					Hold,
					{ name: "gone" },
					{ ownership: { kind: "conversation" }, conversationId: root.id },
				);
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
				return {
					owner,
					inner: await tx.createTask(
						Hold,
						{ name: "orphan" },
						{ ownership: { kind: "conversation" }, conversationId: child.id },
					),
				};
			}, context);
			await session.commit(async (tx) => {
				const record = (await tx.task(tree.owner))!;
				(tx as unknown as { setTask(value: unknown): void }).setTask({ ...record, abortRequested, state });
			}, context);
			await session.close(context);

			const { harness } = await openHarness(await openNodeSqliteStorage(path));
			expect((await harness.waitForTask(tree.inner, context)).state.outcome.status).toBe("aborted");
			// The owner finishes only after the work below it.
			const outcome = (await harness.waitForTask(tree.owner, context)).state.outcome.status;
			expect(outcome).toBe(abortRequested ? "aborted" : "failed");
			await harness.close(context);
		});
	}

	it("withdraws an input queued below a held failed owner after its cascade", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner", { slowInner: true });
		const child = (await harness.conversation(tree.child, context))!;
		// The inner task stands in for the child's run, which stays busy after the cascade.
		await busy(child, tree.inner);
		open("owner", "failed");
		await waitUntil(async () => (await harness.getTask(tree.inner, context))!.abortRequested);
		const late = await child.submit({ type: "input", content: "late" }, context);
		expect(await late.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		open("abort.owner.inner", "completed");
		await harness.waitForTask(tree.owner, context);
		await harness.close(context);
	});

	it("marks work admitted after reopen below a cancelled owner whose edge was not loaded", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-ownership-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		let opened = await openHarness(await openNodeSqliteStorage(path));
		const tree = await ownedChild(opened.root, "owner", { slowOwner: true });
		open("owner.inner", "completed");
		await opened.harness.waitForTask(tree.inner, context);
		// The owner stays live and cancelled in its slow abort handler.
		await opened.harness.abortTask(tree.owner, context);
		await opened.harness.close(context);

		// The child is empty at open, so nothing loads its edge until new work arrives.
		opened = await openHarness(await openNodeSqliteStorage(path));
		const child = (await opened.harness.conversation(tree.child, context))!;
		const late = await child.commit(
			(tx) => tx.createTask(Hold, { name: "late" }, { ownership: { kind: "conversation" } }),
			context,
		);
		expect((await opened.harness.waitForTask(late, context)).state.outcome.status).toBe("aborted");
		open("abort.owner", "completed");
		expect((await opened.harness.waitForTask(tree.owner, context)).state.outcome.status).toBe("aborted");
		await opened.harness.close(context);
	});

	it("cascades from an owner the scheduler orphans", async () => {
		const { harness, root } = await openHarness();
		const { owner, inner } = await root.commit(async (tx) => {
			const owner = await tx.createTask(
				Unregistered,
				{ name: "unregistered" },
				{ ownership: { kind: "conversation" } },
			);
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
			return {
				owner,
				inner: await tx.createTask(
					Hold,
					{ name: "below" },
					{ ownership: { kind: "conversation" }, conversationId: child.id },
				),
			};
		}, context);
		expect(await harness.abortTask(owner, context)).toBe("marked");
		expect((await harness.waitForTask(owner, context)).state.outcome).toEqual({
			status: "orphaned",
			reason: "missing_task",
		});
		expect((await harness.waitForTask(inner, context)).state.outcome.status).toBe("aborted");
		await harness.close(context);
	});

	it("cancels only the caller's wait, never the shared work", async () => {
		const { harness, root } = await openHarness();
		const tree = await ownedChild(root, "owner");
		const waiting = new AbortController();
		const idle = root.waitForIdle({ ...context, abortSignal: waiting.signal });
		waiting.abort(new Error("stop waiting"));
		await expect(idle).rejects.toThrow("stop waiting");
		expect((await status(harness, tree.inner)).status).not.toBe("terminal");

		// Cancelling an abort after its commit leaves the marks in place.
		const slow = await ownedChild(root, "slow");
		await root.commit(async (tx) => {
			const record = (await tx.task(slow.owner))!;
			(tx as unknown as { setTask(value: unknown): void }).setTask({
				...record,
				input: { name: "slow", slowAbort: true },
			});
		}, context);
		const aborting = new AbortController();
		const abort = root.abort({ ...context, abortSignal: aborting.signal });
		await waitUntil(async () => (await harness.getTask(slow.owner, context))!.abortRequested);
		aborting.abort(new Error("stop aborting"));
		await expect(abort).rejects.toThrow("stop aborting");
		open("abort.slow", "completed");
		for (const id of [tree.owner, tree.inner, slow.owner, slow.inner]) {
			expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("aborted");
		}
		await harness.close(context);
	});

	it("aborts a waiting child whose awaited task completes in the commit that marks its owner", async () => {
		const { harness, root } = await openHarness();
		const { owner, dependency, blocked } = await root.commit(async (tx) => {
			const owner = await tx.createTask(Hold, { name: "owner" }, { ownership: { kind: "conversation" } });
			const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner } });
			const dependency = await tx.createTask(Hold, { name: "dependency" }, { ownership: { kind: "conversation" } });
			const blocked = await tx.createTask(
				Waiter,
				{ on: [dependency] },
				{ ownership: { kind: "conversation" }, conversationId: child.id },
			);
			return { owner, dependency, blocked };
		}, context);
		await waitUntil(async () => runs.get("dependency") === 1 && runs.get("owner") === 1);
		await waitUntil(async () => (await status(harness, blocked)).status === "waiting");
		// One commit completes the dependency and marks the owner.
		await root.commit(async (tx) => {
			const setTask = (value: unknown) => (tx as unknown as { setTask(value: unknown): void }).setTask(value);
			const completedDependency = (await tx.task(dependency))!;
			const marked = (await tx.task(owner))!;
			setTask({
				...completedDependency,
				state: { status: "terminal", outcome: { status: "completed", result: null } },
			});
			setTask({ ...marked, abortRequested: true });
		}, context);
		expect((await harness.waitForTask(blocked, context)).state.outcome.status).toBe("aborted");
		await harness.close(context);
	});

	it("applies marks found through an edge loaded after reopen once a failed cascade commit is reopened", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-ownership-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		let opened = await openHarness(await openNodeSqliteStorage(path));
		const tree = await ownedChild(opened.root, "owner", { slowOwner: true });
		open("owner.inner", "completed");
		await opened.harness.waitForTask(tree.inner, context);
		await opened.harness.abortTask(tree.owner, context);
		await opened.harness.close(context);

		const storage = await openNodeSqliteStorage(path);
		let rejectMark: TaskId | undefined;
		const commit = storage.commit.bind(storage);
		storage.commit = async (writes, adopt, ctx) => {
			if (
				writes.some((write) => write.type === "task" && write.value.id === rejectMark && write.value.abortRequested)
			) {
				rejectMark = undefined;
				throw new Error("disk gone");
			}
			return commit(writes, adopt, ctx);
		};
		opened = await openHarness(storage);
		const child = (await opened.harness.conversation(tree.child, context))!;
		const late = await child.commit(async (tx) => {
			const id = await tx.createTask(Hold, { name: "late" }, { ownership: { kind: "conversation" } });
			rejectMark = id;
			return id;
		}, context);
		// The failed cascade commit fails the Harness. `closed` settles once its invocations have ended, and the owner's
		// abort handler ignores its signal: let it return.
		open("abort.owner", "completed");
		expect(await opened.harness.closed).toMatchObject({ kind: "failed" });
		await opened.harness.close(context);
		// Reopening derives the mark again.
		opened = await openHarness(await openNodeSqliteStorage(path));
		expect((await opened.harness.waitForTask(late, context)).state.outcome.status).toBe("aborted");
		await opened.harness.close(context);
	});

	it("fails the Harness on a failed cascade commit, and reopening applies the cascade", async () => {
		const failure = new Error("disk gone");
		let failMark: TaskId | undefined;
		class Failing extends ControlledStorage {
			override async commit(
				writes: Parameters<MemoryStorage["commit"]>[0],
				adopt: Parameters<MemoryStorage["commit"]>[1],
				ctx: Parameters<MemoryStorage["commit"]>[2],
			) {
				const marks = writes.some(
					(write) => write.type === "task" && write.value.id === failMark && write.value.abortRequested,
				);
				if (marks) {
					failMark = undefined;
					throw failure;
				}
				return super.commit(writes, adopt, ctx);
			}
		}
		const storage = new Failing();
		const { harness, root, reports } = await openHarness(storage);
		const tree = await ownedChild(root, "owner");
		failMark = tree.inner;
		open("owner", "failed");
		expect(await harness.closed).toEqual({ kind: "failed", error: failure });
		expect(reports).toEqual([failure]);
		await harness.close(context);
		const reopened = await openHarness(storage.reopen());
		expect((await reopened.harness.waitForTask(tree.inner, context)).state.outcome.status).toBe("aborted");
		await reopened.harness.close(context);
	});
});

describe("owned conversations from tools and supervisors", () => {
	it("gives a tool an invocation-bound handle whose submissions stay durable after the call ends", async () => {
		const setup = chatSetup();
		let handle: ConversationHandle | undefined;
		let missing: ConversationHandle | undefined = {} as ConversationHandle;
		let submission: Submission | undefined;
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Delegates",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
						return created.id;
					}, callContext);
					missing = await api.conversation(99_999 as ConversationId, callContext);
					handle = (await api.conversation(child, callContext))!;
					submission = await handle.submit(
						{ type: "input", content: "child task", requestId: "child" },
						callContext,
					);
					const settled = await submission.wait(callContext);
					return { output: [{ type: "text", text: settled.status }] };
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", {}, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("child answer")]),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(missing).toBeUndefined();
		// The call ended: the handle and its submission reject, while the submission record remains.
		await expect(handle!.submit({ type: "input", content: "again" }, context)).rejects.toThrow(
			"invocation has ended",
		);
		await expect(handle!.waitForIdle(context)).rejects.toThrow("invocation has ended");
		await expect(handle!.abort(context)).rejects.toThrow("invocation has ended");
		await expect(submission!.wait(context)).rejects.toThrow("invocation has ended");
		// Nothing was admitted or marked after the call ended.
		const childConversation = (await harness.conversation(handle!.id, context))!;
		const childEntries = (await childConversation.entries({}, 100, undefined, context)).items;
		expect(childEntries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
		const childTasks = (await harness.inspect(context)).tasks.filter(
			(task) => task.record.conversationId === handle!.id,
		);
		expect(childTasks).toEqual([]);
		expect((await (await harness.submission(submission!.id, context))!.status(context)).status).toBe("done");
		await harness.close(context);
	});

	it("rejects a handle operation queued on the line when the invocation ends before it runs", async () => {
		const setup = chatSetup();
		const ready = deferred<{ child: ConversationId; taskId: TaskId }>();
		const go = deferred();
		const queued = deferred<{ submitting: Promise<unknown> }>();
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Delegates late",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						return created.id;
					}, callContext);
					const handle = (await api.conversation(child, callContext))!;
					ready.resolve({ child, taskId: api.taskId });
					await go.promise;
					// Called while the invocation is alive, with a context that is not the call's: the handle binds it to the
					// invocation. It reaches the line only after the abort mark.
					const submitting = handle.submit({ type: "input", content: "late" }, context);
					submitting.catch(() => {});
					queued.resolve({ submitting });
					return aborted(callContext.abortSignal!);
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", {}, { id: "c1" })], { stopReason: "toolUse" }),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.submit({ type: "input", content: "go" }, context);
		const { child, taskId } = await ready.promise;
		// Hold the Session line, queue the abort mark behind it, then let the tool queue its submit.
		const release = deferred();
		const holding = root.commit(async () => {
			await release.promise;
		}, context);
		const aborting = harness.abortTask(taskId, context);
		go.resolve();
		const { submitting } = await queued.promise;
		release.resolve();
		await holding;
		await aborting;
		await expect(submitting).rejects.toThrow();
		const childConversation = (await harness.conversation(child, context))!;
		expect((await childConversation.entries({}, 10, undefined, context)).items).toEqual([]);
		expect((await harness.inspect(context)).submissions.filter((record) => record.conversationId === child)).toEqual(
			[],
		);
		await harness.close(context);
	});

	it("aborts a subagent run with its parent's conversation, rejecting the waiting tool", async () => {
		const setup = chatSetup();
		let child: ConversationId | undefined;
		const toolWait = deferred<string>();
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Delegates",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
						return created.id;
					}, callContext);
					const submission = await (await api.conversation(child, callContext))!.submit(
						{ type: "input", content: "child task" },
						callContext,
					);
					try {
						return { output: [{ type: "text", text: (await submission.wait(callContext)).status }] };
					} catch (error) {
						toolWait.resolve((error as Error).message);
						throw error;
					}
				},
			}),
		);
		const childRun = gated(fauxAssistantMessage([fauxText("never")]));
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", {}, { id: "c1" })], { stopReason: "toolUse" }),
			childRun.step,
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "go" }, context);
		await childRun.reached;
		await root.abort(context);
		expect(await input.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(await toolWait.promise).toBeTruthy();
		const childConversation = (await harness.conversation(child!, context))!;
		await childConversation.waitForIdle(context);
		const childLive = await harness.snapshot(LiveDoc, child!, context);
		expect(childLive).toEqual({ runFailure: expect.objectContaining({ reason: "aborted" }) });
		const childInputs = (await harness.inspect(context)).submissions.filter((s) => s.conversationId === child);
		expect(childInputs).toEqual([]);
		await harness.waitForIdle(context);
		await harness.close(context);
	});

	it("lets a running tool abort its owned child and continue", async () => {
		const setup = chatSetup();
		const childRun = gated(fauxAssistantMessage([fauxText("never")]));
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Delegates and cancels",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
						return created.id;
					}, callContext);
					const handle = (await api.conversation(child, callContext))!;
					const submission = await handle.submit({ type: "input", content: "child task" }, callContext);
					await childRun.reached;
					await handle.abort(callContext);
					const settledChild = await submission.wait(callContext);
					return { output: [{ type: "text", text: `child ${settledChild.status}` }] };
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("delegate", {}, { id: "c1" })], { stopReason: "toolUse" }),
			childRun.step,
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		expect((await (await root.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe("done");
		await harness.close(context);
	});

	it("aborts the children of a tool call that throws or is interrupted, while the run continues", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-tool-children-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const children: TaskId[] = [];
		const toolRunning = deferred();
		const setup = chatSetup();
		addTask(setup.registry, Hold);
		addTool(
			setup.registry,
			defineTool({
				name: "spawn",
				description: "Starts owned work, then throws or hangs",
				parameters: Type.Object({ mode: Type.String() }),
				execute: async (args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						return tx.createTask(
							Hold,
							{ name: `child.${api.callId}` },
							{ ownership: { kind: "conversation" }, conversationId: created.id },
						);
					}, callContext);
					children.push(child);
					if (args.mode === "throw") throw new Error("spawn failed");
					toolRunning.resolve();
					return aborted(callContext.abortSignal!);
				},
			}),
		);
		const call = (mode: string, id: string) =>
			fauxAssistantMessage([fauxToolCall("spawn", { mode }, { id })], { stopReason: "toolUse" });
		setup.faux.setResponses([
			call("throw", "c1"),
			fauxAssistantMessage([fauxText("after throw")]),
			call("hang", "c2"),
		]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		expect((await (await opened.root.submit({ type: "input", content: "one" }, context)).wait(context)).status).toBe(
			"done",
		);
		expect((await opened.harness.waitForTask(children[0]!, context)).state.outcome.status).toBe("aborted");

		// The second call hangs until the process stops; on reopen it is interrupted.
		const second = (await opened.root.submit({ type: "input", content: "two" }, context)).id;
		await toolRunning.promise;
		await opened.harness.close(context);
		setup.faux.setResponses([fauxAssistantMessage([fauxText("after interrupt")])]);
		opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		expect((await opened.harness.waitForTask(children[1]!, context)).state.outcome.status).toBe("aborted");
		expect((await (await opened.harness.submission(second, context))!.wait(context)).status).toBe("done");
		const tools = (await opened.harness.commit((tx) => tx.scanTasks({ kind: "pi.tool" }, 10), context)).items;
		expect(tools.map((task) => task.state.status === "terminal" && task.state.outcome.status)).toEqual([
			"failed",
			"failed",
		]);
		await opened.harness.close(context);
	});

	it("reruns a replay-safe subagent tool after a restart with the same child and submission", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-safe-subagent-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const children: ConversationId[] = [];
		const setup = chatSetup();
		addTool(
			setup.registry,
			defineTool({
				name: "subagent",
				description: "Delegates",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async (_args, api, callContext) => {
					const child = await api.commit(async (tx) => {
						const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
						if (existing !== undefined) return existing.id;
						const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
						await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
						return created.id;
					}, callContext);
					children.push(child);
					const request = { type: "input", content: "child task", requestId: `subagent:${api.taskId}` } as const;
					const submission = await (await api.conversation(child, callContext))!.submit(request, callContext);
					const settled = await submission.wait(callContext);
					return { output: [{ type: "text", text: settled.status }] };
				},
			}),
		);
		const childRun = gated(fauxAssistantMessage([fauxText("never")]));
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", {}, { id: "c1" })], { stopReason: "toolUse" }),
			childRun.step,
		]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		const input = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await childRun.reached;
		await opened.harness.close(context);

		setup.faux.setResponses([
			fauxAssistantMessage([fauxText("child answer")]),
			fauxAssistantMessage([fauxText("done")]),
		]);
		opened = await openChat(await openNodeSqliteStorage(path), setup);
		expect((await (await opened.harness.submission(input, context))!.wait(context)).status).toBe("done");
		expect(children).toHaveLength(2);
		expect(children[1]).toBe(children[0]);
		const child = (await opened.harness.conversation(children[0]!, context))!;
		const entries = (await child.entries({}, 100, undefined, context)).items;
		expect(entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
		const results = (await opened.root.context(context)).messages.filter((message) => message.role === "toolResult");
		expect(results.map((message) => message.isError)).toEqual([false]);
		await opened.harness.close(context);
	});

	it("lets a background supervisor resubmit after a restart without submitting twice", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-supervisor-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const Children = defineDoc<{ child?: ConversationId }>({
			checkpointWhen: () => false,
			kind: "test.children",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "initial",
			initial: () => ({}),
		});
		const Supervisor = defineTask<{ parent: ConversationId }, { phase: "run" }, { answer: EntryId }>({
			name: "test.supervisor",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (task, runtime, ctx) => {
					const id = (await runtime.snapshot(Children, task.input.parent, ctx))!.child!;
					const child = (await runtime.conversation(id, ctx))!;
					const submission = await child.submit({ type: "input", content: "work", requestId: "stable" }, ctx);
					const settled = await submission.wait(ctx);
					if (settled.status !== "done" || settled.type !== "input") throw new Error(settled.status);
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: { answer: settled.answer } } }),
						ctx,
					);
				},
			},
			abort: (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
		});
		const setup = chatSetup();
		addTask(setup.registry, Supervisor);
		const first = gated(fauxAssistantMessage([fauxText("never")]));
		setup.faux.setResponses([first.step, fauxAssistantMessage([fauxText("answer")])]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		const root = opened.root;
		const { supervisor, child } = await root.commit(async (tx) => {
			const supervisor = await tx.createTask(
				Supervisor,
				{ parent: root.id },
				{ ownership: { kind: "conversation" }, background: true },
			);
			const created = await tx.createConversation({ ownership: { kind: "task", taskId: supervisor } });
			await configure(tx, created.id, { model: { provider: "faux", modelId: "faux-1" } });
			(await tx.doc(Children, root.id)).child = created.id;
			return { supervisor, child: created.id };
		}, context);
		opened.harness.resume();
		// The submission is admitted and its generation requested; then the process stops.
		await first.reached;
		await opened.harness.close(context);

		opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		const done = await opened.harness.waitForTask(supervisor, context);
		expect(done.state.outcome.status).toBe("completed");
		const childConversation = (await opened.harness.conversation(child, context))!;
		const entries = (await childConversation.entries({}, 100, undefined, context)).items;
		expect(entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
		// The root never waited for the background supervisor.
		await opened.root.waitForIdle(context);
		await opened.harness.close(context);
	});
});
