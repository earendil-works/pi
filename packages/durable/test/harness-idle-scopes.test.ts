// Idle checks without per-commit scans: a task change settles only the conversations above it (idle waiters and kept
// context ranges), expiry runs oldest first from an ordered index, and `wake()` reads only sleeping tasks while work
// is active. Every case checks the incremental idle state against a full recompute (`SCHEDULER_IDLE_STATE`).
import { createModels } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	MemoryStorage,
	type SetTimer,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEDULER_IDLE_STATE } from "../src/harness/harness.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";
import { ROOT_CONVERSATION_ID, type StorageWrite } from "../src/types.ts";
import { ControlledStorage, context, flush } from "./session-support.ts";
import { aborted, type Deferred, deferred, eventually, openTasks, settled } from "./task-support.ts";

const gates = new Map<string, Deferred<void>>();
/** Resolves once the named task's context read returned. */
const reads = new Map<string, Deferred<void>>();

function named<T>(map: Map<string, Deferred<T>>, name: string): Deferred<T> {
	let found = map.get(name);
	if (found === undefined) {
		found = deferred<T>();
		map.set(name, found);
	}
	return found;
}

afterEach(() => {
	gates.clear();
	reads.clear();
});

/**
 * Reads the context of conversation `read` (when given), then holds until its gate opens and completes; its abort
 * handler ends it `aborted`.
 */
const Work = defineTask<{ name: string; read?: number }, { phase: "run" }, null>({
	name: "test.idle.work",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, ctx) => {
			if (task.input.read !== undefined) {
				await runtime.context(task.input.read as ConversationId, ctx);
				named(reads, task.input.name).resolve();
			}
			const opened = await Promise.race([
				named(gates, task.input.name).promise.then(() => true),
				aborted(runtime.signal),
			]);
			if (opened !== true) return;
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
		},
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

type IdleState = Record<"contexts" | "idleContexts" | "idleMismatches" | "fullIdleChecks", number>;

function idleState(harness: Harness): IdleState {
	return (harness as unknown as Record<symbol, IdleState>)[SCHEDULER_IDLE_STATE]!;
}

/** Background timers declined, as Cloudflare Workers do; foreground ones on `setTimeout`. */
const declineBackground: SetTimer = (callback, delayMs, { background }) => {
	if (background) return undefined;
	const timer = setTimeout(callback, delayMs);
	return () => clearTimeout(timer);
};

/**
 * A resumed Harness running `Work`, over MemoryStorage counting the entry rows each scan returns, with `clock` as its
 * time, the retention `retention` returns, and background timers declined unless `timers`.
 */
async function open(options: { clock?: () => number; retention?: () => number; timers?: boolean } = {}) {
	const scanned = { rows: 0 };
	const memory = new MemoryStorage();
	const storage = new Proxy<Storage>(memory, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key, target);
			if (key === "scanEntries") {
				return async (...args: Parameters<Storage["scanEntries"]>) => {
					const page = await target.scanEntries(...args);
					scanned.rows += page.items.length;
					return page;
				};
			}
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "tasks", tasks: [Work] }));
	const retention = options.retention ?? (() => 600_000);
	const harness = await Harness.open(
		storage,
		{
			models: createModels(),
			registry,
			settings: () => ({ contextRetentionMs: retention() }),
			...(options.clock === undefined ? {} : { now: options.clock }),
			...(options.timers === true ? {} : { setTimer: declineBackground }),
		},
		context,
	);
	harness.resume();
	const root = await harness.root(context);
	/** A new ownerless conversation with `entries` entries. */
	const conversation = async (entries = 2): Promise<Conversation> => {
		const created = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		for (let index = 0; index < entries; index++) {
			await created.commit((tx) => tx.appendEntry(created.id, { kind: "note", data: { index } }), context);
		}
		return created;
	};
	/** Start `Work` named `name` in `into`, reading conversation `read`, and wait for its read. */
	const work = async (name: string, into: Conversation, read?: ConversationId): Promise<TaskId> => {
		const input = read === undefined ? { name } : { name, read: read as number };
		const id = await into.commit(
			(tx) => tx.createTask(Work, input, { ownership: { kind: "conversation" }, conversationId: into.id }),
			context,
		);
		if (read !== undefined) await named(reads, name).promise;
		return id;
	};
	/** Open the gate of `name` and wait for its task, `id`, to end. */
	const end = async (name: string, id: TaskId): Promise<void> => {
		named(gates, name).resolve();
		await harness.waitForTask(id, context);
	};
	/** The entry rows a read of `read` from a new task in `into` scans. */
	const rowsOf = async (name: string, into: Conversation, read: ConversationId): Promise<number> => {
		const before = scanned.rows;
		const id = await work(name, into, read);
		const rows = scanned.rows - before;
		await end(name, id);
		return rows;
	};
	return { harness, root, conversation, work, end, rowsOf };
}

/** Flush until scheduler passes started by the last changes settled. */
async function quiet(): Promise<void> {
	for (let round = 0; round < 4; round++) await flush();
}

describe("idle waiters by scope", () => {
	it("resolve through owner chains, owned conversations and ended tasks between, ignoring background work", async () => {
		const { harness, root } = await open();
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Work, { name: "p" }, { ownership: { kind: "conversation" } });
			const b = await tx.createTask(Work, { name: "b" }, { ownership: { kind: "task", taskId: p } });
			const a = await tx.createTask(Work, { name: "a" }, { ownership: { kind: "task", taskId: b } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: a } });
			const d = await tx.createTask(
				Work,
				{ name: "d" },
				{ ownership: { kind: "conversation" }, conversationId: c.id },
			);
			const g = await tx.createTask(
				Work,
				{ name: "g" },
				{ ownership: { kind: "conversation" }, conversationId: c.id, background: true },
			);
			return { p, b, a, c: c.id, d, g };
		}, context);
		const c = (await harness.conversation(tree.c, context))!;
		const idleC = c.waitForIdle(context);
		const idleRoot = root.waitForIdle(context);
		const idleAll = harness.waitForIdle(context);
		// The owners A and B hold for D: live, though their handlers returned.
		named(gates, "a").resolve();
		named(gates, "b").resolve();
		await eventually(async () => (await harness.getTask(tree.b, context))!.state.status === "completing");
		expect([await settled(idleC), await settled(idleRoot), await settled(idleAll)]).toEqual([false, false, false]);
		// D ends: C is idle (G is background); A and B finalize; P still holds the root.
		named(gates, "d").resolve();
		await idleC;
		await harness.waitForTask(tree.b, context);
		expect([await settled(idleRoot), await settled(idleAll)]).toEqual([false, false]);
		named(gates, "p").resolve();
		await idleRoot;
		await idleAll;
		expect((await harness.getTask(tree.g, context))!.state.status).not.toBe("terminal");
		await harness.close(context);
	});

	it("count work whose chain is not loaded yet as inside, until the open reconcile loads it", async () => {
		const storage = new ControlledStorage();
		const first = await openTasks(storage, [Work]);
		const firstRoot = await first.harness.root(context);
		const tree = await firstRoot.commit(async (tx) => {
			const p = await tx.createTask(Work, { name: "p" }, { ownership: { kind: "conversation" } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: p } });
			const d = await tx.createTask(
				Work,
				{ name: "d" },
				{ ownership: { kind: "conversation" }, conversationId: c.id },
			);
			const other = await tx.createConversation({ ownership: { kind: "ownerless" } });
			return { p, c: c.id, d, other: other.id };
		}, context);
		await first.harness.close(context);
		// Reopened, no chain is loaded: P and D count as inside every scope until the reconcile pass loads theirs.
		const { harness } = await openTasks(storage.reopen(), [Work]);
		const idleOther = (await harness.conversation(tree.other, context))!.waitForIdle(context);
		const idleRoot = (await harness.root(context)).waitForIdle(context);
		await idleOther;
		expect(await settled(idleRoot)).toBe(false);
		harness.resume();
		named(gates, "d").resolve();
		await harness.waitForTask(tree.d, context);
		expect(await settled(idleRoot)).toBe(false);
		named(gates, "p").resolve();
		await idleRoot;
		await harness.close(context);
	});

	it("resolve a waiter on an unrelated conversation without settling the busy one", async () => {
		const { harness, conversation, work, end } = await open();
		const [busy, other] = [await conversation(0), await conversation(0)];
		const held = await work("held", busy);
		const quick = await work("quick", other);
		const idleBusy = busy.waitForIdle(context);
		const idleOther = other.waitForIdle(context);
		await end("quick", quick);
		await idleOther;
		expect(await settled(idleBusy)).toBe(false);
		await end("held", held);
		await idleBusy;
		await harness.close(context);
	});
});

describe("kept context ranges", () => {
	it("settles a run end whose sweep drops the chain without a check of every scope", async () => {
		const { harness, root } = await open();
		const tree = await root.commit(async (tx) => {
			const p = await tx.createTask(Work, { name: "p" }, { ownership: { kind: "conversation" } });
			const t = await tx.createTask(Work, { name: "t" }, { ownership: { kind: "task", taskId: p } });
			const c = await tx.createConversation({ ownership: { kind: "task", taskId: t } });
			// A context range keeps entries: an empty conversation has none to keep.
			await tx.appendEntry(c.id, { kind: "note" });
			return { p, t, c: c.id };
		}, context);
		const c = (await harness.conversation(tree.c, context))!;
		const d = await c.commit(
			(tx) =>
				tx.createTask(
					Work,
					{ name: "d", read: tree.c as number },
					{ ownership: { kind: "conversation" }, conversationId: tree.c },
				),
			context,
		);
		await named(reads, "d").promise;
		named(gates, "t").resolve();
		await eventually(async () => (await harness.getTask(tree.t, context))!.state.status === "completing");
		await quiet();
		const before = idleState(harness);
		expect(before).toMatchObject({ contexts: 1, idleContexts: 0, idleMismatches: 0 });
		// D's end makes C idle, T finalizes, and the sweep forgets C's chain: none of it checks every scope.
		named(gates, "d").resolve();
		await harness.waitForTask(d, context);
		await harness.waitForTask(tree.t, context);
		await quiet();
		expect(idleState(harness)).toEqual({ ...before, idleContexts: 1 });
		named(gates, "p").resolve();
		await harness.waitForTask(tree.p, context);
		await harness.close(context);
	});

	it("drops a range past its retention when a task change makes it busy again, with background timers declined", async () => {
		let clock = 1_000;
		const { harness, conversation, work, end } = await open({ clock: () => clock, retention: () => 1_000 });
		const [x, z] = [await conversation(), await conversation(0)];
		await end("reader", await work("reader", z, x.id));
		expect(idleState(harness)).toMatchObject({ contexts: 1, idleContexts: 1, idleMismatches: 0 });
		clock = 2_500;
		// No timer expired it; the task change that makes X busy checks expiry first.
		const busy = await work("busy", x);
		await quiet();
		expect(idleState(harness)).toMatchObject({ contexts: 0, idleContexts: 0, idleMismatches: 0 });
		await end("busy", busy);
		await harness.close(context);
	});

	it("drops a range past its retention at a reconcile pass with nothing to do, with background timers declined (review)", async () => {
		let clock = 1_000;
		const { harness, conversation, work, end } = await open({ clock: () => clock, retention: () => 1_000 });
		const [x, z] = [await conversation(), await conversation(0)];
		await end("reader", await work("reader", z, x.id));
		const held = await work("held", z);
		// Held runs: no task changes from here.
		await quiet();
		expect(idleState(harness)).toMatchObject({ contexts: 1, idleContexts: 1 });
		clock = 2_500;
		// A wait on busy Z asks for a reconcile pass, which has no work and changes no task: it checks expiry.
		const idle = z.waitForIdle(context);
		await quiet();
		expect(idleState(harness)).toMatchObject({ contexts: 0, idleMismatches: 0 });
		await end("held", held);
		await idle;
		await harness.close(context);
	});

	it("expires in idle order when the clock goes back", async () => {
		let clock = 1_000;
		const { harness, conversation, work, end, rowsOf } = await open({
			clock: () => clock,
			retention: () => 1_000,
		});
		const [a, b, z] = [await conversation(3), await conversation(5), await conversation(0)];
		await end("read a", await work("read a", z, a.id));
		clock = 500;
		await end("read b", await work("read b", z, b.id));
		expect(idleState(harness)).toMatchObject({ contexts: 2, idleContexts: 2, idleMismatches: 0 });
		// B went idle at 500 and expires first, though it went idle last.
		clock = 1_600;
		await end("unrelated", await work("unrelated", z));
		expect(idleState(harness)).toMatchObject({ contexts: 1, idleMismatches: 0 });
		expect(await rowsOf("again b", z, b.id)).toBe(5);
		expect(await rowsOf("again a", z, a.id)).toBe(0);
		await harness.close(context);
	});

	it("drops every idle range when retention becomes zero, also one that went idle after the clock's now (review)", async () => {
		let clock = 2_000;
		let retention = 1_000;
		const { harness, conversation, work, end } = await open({ clock: () => clock, retention: () => retention });
		const [a, z] = [await conversation(), await conversation(0)];
		await end("read", await work("read", z, a.id));
		expect(idleState(harness)).toMatchObject({ contexts: 1, idleContexts: 1 });
		// The clock goes back below A's idle start; then retention 0 and an unrelated task change.
		clock = 1_000;
		retention = 0;
		await end("unrelated", await work("unrelated", z));
		expect(idleState(harness)).toMatchObject({ contexts: 0, idleMismatches: 0 });
		await harness.close(context);
	});

	it("keeps an idle range's expiry when another task reads it again", async () => {
		let clock = 1_000;
		const { harness, conversation, work, end, rowsOf } = await open({
			clock: () => clock,
			retention: () => 1_000,
		});
		const [a, b, z] = [await conversation(3), await conversation(5), await conversation(0)];
		await end("read a", await work("read a", z, a.id));
		clock = 1_500;
		await end("read b", await work("read b", z, b.id));
		clock = 1_800;
		expect(await rowsOf("again a", z, a.id)).toBe(0);
		clock = 2_100;
		await end("unrelated", await work("unrelated", z));
		expect(idleState(harness)).toMatchObject({ contexts: 1, idleMismatches: 0 });
		expect(await rowsOf("late b", z, b.id)).toBe(0);
		await harness.close(context);
	});

	it("drops a range from the expiry order when an entry commit finds it expired", async () => {
		let clock = 1_000;
		const { harness, conversation, work, end } = await open({ clock: () => clock, retention: () => 1_000 });
		const [a, z] = [await conversation(), await conversation(0)];
		await end("read", await work("read", z, a.id));
		clock = 2_500;
		// An entry-only commit settles no idleness: the range is dropped where it would be extended.
		await a.commit((tx) => tx.appendEntry(a.id, { kind: "note", data: { late: true } }), context);
		expect(idleState(harness)).toMatchObject({ contexts: 0, idleContexts: 0, idleMismatches: 0 });
		await harness.close(context);
	});

	it("drops a range from the expiry order when an entry commit cannot extend it", async () => {
		const { harness, conversation, work, end } = await open();
		const [a, z] = [await conversation(0), await conversation(0)];
		const first = await a.commit((tx) => tx.appendEntry(a.id, { kind: "note" }), context);
		const second = await a.commit((tx) => tx.appendEntry(a.id, { kind: "note" }), context);
		await a.commit((tx) => tx.appendEntry(a.id, { kind: "summary", head: second.id }), context);
		await end("read", await work("read", z, a.id));
		expect(idleState(harness)).toMatchObject({ contexts: 1, idleContexts: 1, idleMismatches: 0 });
		// A marker whose head is older than the range's: the range cannot be extended and is dropped.
		await a.commit((tx) => tx.appendEntry(a.id, { kind: "summary", head: first.id }), context);
		expect(idleState(harness)).toMatchObject({ contexts: 0, idleContexts: 0, idleMismatches: 0 });
		await harness.close(context);
	});

	it.each([
		["shorter", 400, 0],
		["longer", 10_000, 1],
		["zero", 0, 0],
	] as const)("applies a %s retention to idle ranges at an unrelated commit", async (_name, changed, kept) => {
		let clock = 1_000;
		let retention = 1_000;
		const { harness, conversation, work, end } = await open({ clock: () => clock, retention: () => retention });
		const [a, z] = [await conversation(), await conversation(0)];
		await end("read", await work("read", z, a.id));
		clock = 1_500;
		retention = changed;
		await end("unrelated", await work("unrelated", z));
		expect(idleState(harness)).toMatchObject({ contexts: kept, idleMismatches: 0 });
		await harness.close(context);
	});

	it("drops a range that goes idle with zero retention", async () => {
		const { harness, conversation, work, end } = await open({ retention: () => 0 });
		const a = await conversation();
		const own = await work("own", a, a.id);
		await quiet();
		expect(idleState(harness)).toMatchObject({ contexts: 1, idleContexts: 0, idleMismatches: 0 });
		await end("own", own);
		await quiet();
		expect(idleState(harness)).toMatchObject({ contexts: 0, idleMismatches: 0 });
		await harness.close(context);
	});
});

/** A random source with a fixed seed. */
function seeded(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
}

describe("incremental idle state", () => {
	it("equals a full recompute after every step of random nested work", async () => {
		const random = seeded(42);
		const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
		const { harness, root } = await open();
		// A context range keeps entries: every conversation gets one.
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		const conversations: ConversationId[] = [root.id];
		const live = new Map<string, { readonly id: TaskId; readonly conversation: ConversationId }>();
		let count = 0;
		let fullChecks = idleState(harness).fullIdleChecks;
		const handle = async (id: ConversationId) => (await harness.conversation(id, context))!;
		for (let step = 0; step < 200; step++) {
			const action = random();
			const name = `t${count++}`;
			if (action < 0.1) {
				const created = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
				await created.commit((tx) => tx.appendEntry(created.id, { kind: "note" }), context);
				conversations.push(created.id);
			} else if (action < 0.45 || live.size === 0) {
				// A task in any conversation, also one whose owner chain ended and was swept; it may read a context.
				const into = pick(conversations);
				const read = random() < 0.6 ? pick(conversations) : undefined;
				const background = random() < 0.15;
				const input = read === undefined ? { name } : { name, read: read as number };
				const target = await handle(into);
				const id = await target.commit(
					(tx) =>
						tx.createTask(Work, input, { ownership: { kind: "conversation" }, conversationId: into, background }),
					context,
				);
				live.set(name, { id, conversation: into });
				if (read !== undefined) await named(reads, name).promise;
			} else if (action < 0.6) {
				// Work a live task owns: a child task, or an owned conversation with a task that reads it.
				const [ownerName, owner] = pick([...live]);
				const state = (await harness.getTask(owner.id, context))?.state.status;
				if (state === undefined || state === "terminal" || state === "completing") {
					live.delete(ownerName);
					continue;
				}
				const conversation = random() < 0.5;
				const created = await (await handle(owner.conversation)).commit(async (tx) => {
					if (!conversation) {
						const id = await tx.createTask(Work, { name }, { ownership: { kind: "task", taskId: owner.id } });
						return { id, into: owner.conversation, read: false };
					}
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: owner.id } });
					await tx.appendEntry(child.id, { kind: "note" });
					const id = await tx.createTask(
						Work,
						{ name, read: child.id as number },
						{ ownership: { kind: "conversation" }, conversationId: child.id },
					);
					return { id, into: child.id, read: true };
				}, context);
				if (created.read) conversations.push(created.into);
				live.set(name, { id: created.id, conversation: created.into });
				if (created.read) await named(reads, name).promise;
			} else {
				const [ended] = pick([...live]);
				live.delete(ended);
				named(gates, ended).resolve();
			}
			await quiet();
			const state = idleState(harness);
			expect(state.idleMismatches, `step ${step}`).toBe(0);
			fullChecks = state.fullIdleChecks;
		}
		const state = idleState(harness);
		expect(state.contexts).toBeGreaterThan(5);
		expect(state.idleContexts).toBeGreaterThan(0);
		expect(state.idleContexts).toBeLessThan(state.contexts);
		expect(fullChecks).toBe(0);
		for (const gate of gates.values()) gate.resolve();
		await harness.close(context);
	});
});

describe("wake()", () => {
	const kind = Work.definition.name;
	const record = (id: number, state: unknown, extra: Record<string, unknown> = {}): StorageWrite => ({
		type: "task",
		value: {
			id,
			conversationId: ROOT_CONVERSATION_ID,
			kind,
			version: 1,
			input: { name: `seeded${id}` },
			state,
			background: false,
			abortRequested: false,
			...extra,
		} as never,
	});
	const sleeping = (until: number) => ({ status: "sleeping", checkpoint: { phase: "run" }, until });
	const SLEEPS = record(10, sleeping(5_000));

	it.each([
		["a sleeping task", [SLEEPS], { active: false, at: 5_000 }],
		[
			"an abort-marked sleeping task, which runs its handler",
			[SLEEPS, record(11, sleeping(3_000), { abortRequested: true })],
			{ active: true, at: 5_000 },
		],
		["a sleeping task that is due", [record(11, sleeping(500))], { active: true }],
		[
			"a task waiting on a live one",
			[SLEEPS, record(11, { status: "waiting", checkpoint: { phase: "run" }, on: [10], policy: "allSettled" })],
			{ active: false, at: 5_000 },
		],
		[
			"a completing task holding for a sleeping child",
			[
				record(11, { status: "completing", outcome: { status: "completed", result: null } }),
				record(10, sleeping(5_000), { owner: 11 }),
			],
			{ active: false, at: 5_000 },
		],
		[
			"a task no definition can take",
			[SLEEPS, record(11, { status: "pending", checkpoint: { phase: "run" } }, { kind: "test.idle.missing" })],
			{ active: false, at: 5_000 },
		],
		[
			"a pending task",
			[SLEEPS, record(11, { status: "pending", checkpoint: { phase: "run" } })],
			{ active: true, at: 5_000 },
		],
	] as const)("with %s", async (_name, writes, expected) => {
		const storage = new MemoryStorage();
		await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }, ...writes], context);
		const { harness } = await openTasks(storage, [Work], { now: () => 1_000 });
		await quiet();
		expect(harness.wake()).toEqual(expected);
		await harness.close(context);
	});

	it("with an invocation running: active, and the earliest sleep still found", async () => {
		const storage = new MemoryStorage();
		await commitWrites(storage, [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }, SLEEPS], context);
		const { harness } = await openTasks(storage, [Work], { now: () => 1_000 });
		harness.resume();
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(Work, { name: "running" }, { ownership: { kind: "conversation" } }),
			context,
		);
		await eventually(async () => (await harness.getTask(id, context))!.state.status === "running");
		expect(harness.wake()).toEqual({ active: true, at: 5_000 });
		named(gates, "running").resolve();
		await harness.waitForTask(id, context);
		await quiet();
		expect(harness.wake()).toEqual({ active: false, at: 5_000 });
		await harness.close(context);
	});
});
