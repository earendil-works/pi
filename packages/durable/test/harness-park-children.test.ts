// Work a parked tool owns (spec suspendable §2.5, §4.4, §4.5): nested calls started without waiting, tasks created
// under keys, which children a restart keeps, and submissions that signal a task when they settle.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	defineSignal,
	defineTask,
	defineTool,
	type EntryRecord,
	type Harness,
	LiveDoc,
	MemoryStorage,
	type Storage,
	SubmissionSettled,
	type TaskId,
	type ToolRegistration,
	ToolResultEntry,
	ToolTask,
	type WakeReason,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, waitFor } from "./chat-support.ts";
import { addHooks, addTask, addTool } from "./harness-support.ts";
import { ControlledStorage, context } from "./session-support.ts";
import { aborted, abortedWith, completed, deferred } from "./task-support.ts";

const Done = defineSignal({ name: "test.done", version: 1, schema: obj({ text: str() }) });

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-children-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

const Topic = obj({ topic: str() });

function tool(
	name: string,
	execute: ToolRegistration["execute"],
	extra: Partial<ToolRegistration> = {},
): ToolRegistration {
	return defineTool({ name, description: name, parameters: Topic, execute, ...extra });
}

function call(name: string, args: Record<string, string> = { topic: "" }): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, args, { id: "c1" })], { stopReason: "toolUse" });
}

const DONE = fauxAssistantMessage([fauxText("done")]);

function results(entries: readonly EntryRecord[]): ToolResultMessage[] {
	return entries.filter((entry) => ToolResultEntry.is(entry)).map((entry) => entry.model![0] as ToolResultMessage);
}

function text(message: ToolResultMessage | undefined): string {
	return (message?.content ?? []).map((item) => (item.type === "text" ? item.text : "")).join("|");
}

async function open(setup: ChatSetup, storage: Storage = new MemoryStorage()) {
	const opened = await openChat(storage, setup);
	opened.harness.resume();
	return opened;
}

/** A nested tool that parks on `Done` under the key `done` until it holds a value, and answers with its text. */
const research = tool(
	"research",
	async (args, api, ctx) => {
		const state = await api.readSignal(Done, "done", ctx);
		if (state !== undefined && "value" in state) {
			return { output: [{ type: "text", text: `${(args as { topic: string }).topic}: ${state.value.text}` }] };
		}
		return { sleep: { signals: [Done.key("done")] } };
	},
	{ replay: "safe" },
);

/** The nested calls of the root conversation that are parked, by call ID. */
async function parkedNested(harness: Harness, count: number): Promise<Map<string, TaskId>> {
	let parked = new Map<string, TaskId>();
	await waitFor(async () => {
		const slots = (await harness.snapshot(LiveDoc, 1 as never, context))?.nestedTools ?? [];
		parked = new Map(slots.flatMap((slot) => (slot.status === "sleeping" ? [[slot.callId, slot.taskId]] : [])));
		return parked.size === count;
	});
	return parked;
}

describe("nested calls without waiting", () => {
	it("park on their handles with policy any and collect the results by key across wakes", async () => {
		const setup = chatSetup();
		addTool(setup.registry, research);
		const wakes: (WakeReason | undefined)[] = [];
		addTool(
			setup.registry,
			defineTool<typeof Topic, never, { done: TaskId[] }>({
				name: "both",
				description: "both",
				parameters: Topic,
				replay: "safe",
				async execute(_args, api, ctx) {
					wakes.push(api.wake);
					const a = await api.executeTool("research", { topic: "x" }, ctx, { key: "a", wait: false });
					const b = await api.executeTool("research", { topic: "y" }, ctx, { key: "b", wait: false });
					const done = new Set(api.checkpoint?.done ?? []);
					if (api.wake?.reason === "tasks") for (const id of api.wake.ended) done.add(id);
					const open = [a, b].filter((nested) => !done.has(nested.taskId));
					if (open.length > 0) {
						return {
							wait: { checkpoint: { done: [...done] }, on: open.map((nested) => nested.taskId), policy: "any" },
						};
					}
					const [ra, rb] = await Promise.all([a.result(ctx), b.result(ctx)]);
					return {
						output: [{ type: "text", text: `${String(ra.structuredOutput)} + ${String(rb.structuredOutput)}` }],
					};
				},
			}),
		);
		setup.faux.setResponses([call("both"), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const parked = await parkedNested(harness, 2);
		await waitFor(() => !harness.wake().active);
		await harness.signal(parked.get("c1/b")!, Done, "done", { text: "bee" }, context);
		await waitFor(async () => (await harness.snapshot(LiveDoc, root.id, context))?.tools?.[0]?.status === "waiting");
		await harness.signal(parked.get("c1/a")!, Done, "done", { text: "ay" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		expect(text(results(await allEntries(root))[0])).toBe("x: ay + y: bee");
		expect(wakes).toEqual([
			undefined,
			{ reason: "tasks", ended: [parked.get("c1/b")] },
			{ reason: "tasks", ended: [parked.get("c1/a")] },
		]);
		await harness.close(context);
	});

	it("need explicit keys after a wake, for nested calls and tasks alike", async () => {
		const setup = chatSetup();
		addTool(setup.registry, research);
		const Idle = defineTask<null, { phase: "run" }, null>({
			name: "test.idle",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: { run: (_task, runtime, ctx) => runtime.commit(() => completed(null), ctx) },
			abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
		});
		addTask(setup.registry, Idle);
		const errors: string[] = [];
		addTool(
			setup.registry,
			tool("woken", async (_args, api, ctx) => {
				if (api.wake === undefined) return { sleep: { until: 0 } };
				await api
					.executeTool("research", { topic: "x" }, ctx, { wait: false })
					.catch((error: Error) => errors.push(error.message));
				await api
					.createTask(Idle, null, { ownership: { kind: "task", taskId: api.taskId } }, ctx)
					.catch((error: Error) => errors.push(error.message));
				return { output: [] };
			}),
		);
		setup.faux.setResponses([call("woken"), DONE]);
		const { harness, root } = await open(setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(errors).toEqual([
			"Tool call c1 needs explicit keys after a wake",
			"Tool call c1 needs explicit keys after a wake",
		]);
		await harness.close(context);
	});
});

describe("tasks created under a key", () => {
	it("return the task a key names, and refuse another kind, other input, or a nested call's key", async () => {
		const setup = chatSetup();
		addTool(setup.registry, research);
		const Child = defineTask<{ n: number }, { phase: "run" }, null>({
			name: "test.keyed",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: { run: (_task, runtime, ctx) => runtime.commit(() => completed(null), ctx) },
			abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
		});
		addTask(setup.registry, Child);
		const seen: (TaskId | string)[] = [];
		addTool(
			setup.registry,
			tool("keyed", async (_args, api, ctx) => {
				const own = { ownership: { kind: "task", taskId: api.taskId } } as const;
				const attempt = (run: () => Promise<TaskId | unknown>) =>
					run().then(
						(id) => void seen.push(id as TaskId),
						(error: Error) => void seen.push(error.message),
					);
				await attempt(() => api.createTask(Child, { n: 1 }, { ...own, key: "k" }, ctx));
				await attempt(() => api.createTask(Child, { n: 1 }, { ...own, key: "k" }, ctx));
				await attempt(() => api.createTask(Child, { n: 2 }, { ...own, key: "k" }, ctx));
				await api.executeTool("research", { topic: "x" }, ctx, { key: "n", wait: false });
				await attempt(() => api.createTask(Child, { n: 1 }, { ...own, key: "n" }, ctx));
				await attempt(() => api.executeTool("research", { topic: "x" }, ctx, { key: "k", wait: false }));
				return { output: [] };
			}),
		);
		setup.faux.setResponses([call("keyed"), DONE]);
		const { harness, root } = await open(setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const [first, again, ...refused] = seen;
		expect(typeof first).toBe("number");
		expect(again).toBe(first);
		expect(refused).toEqual([
			"Key k of tool call c1 was already used for another call or task",
			"Key n of tool call c1 was already used for another call or task",
			"Nested call c1/k was already made with another tool or other arguments",
		]);
		await harness.close(context);
	});
});

describe("children after a restart", () => {
	it("keeps the children of a parked replay-unsafe call", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		addTool(setup.registry, research);
		addTool(
			setup.registry,
			tool("unsafe", async (_args, api, ctx) => {
				const nested = await api.executeTool("research", { topic: "x" }, ctx, { key: "a", wait: false });
				if (api.wake === undefined) return { wait: { on: [nested.taskId], policy: "allSettled" } };
				return { output: [{ type: "text", text: String((await nested.result(ctx)).structuredOutput) }] };
			}),
		);
		setup.faux.setResponses([call("unsafe"), DONE]);
		let opened = await open(setup, await openNodeSqliteStorage(path));
		const submissionId = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		const parked = await parkedNested(opened.harness, 1);
		await opened.harness.close(context);
		opened = await open(setup, await openNodeSqliteStorage(path));
		const child = parked.get("c1/a")!;
		await waitFor(() => !opened.harness.wake().active);
		// Not abandoned: its owner was parked, not cut off while running.
		expect((await opened.harness.getTask(child, context))?.abortRequested).toBe(false);
		await opened.harness.signal(child, Done, "done", { text: "kept" }, context);
		expect((await (await opened.harness.submission(submissionId, context))!.wait(context)).status).toBe("done");
		expect(text(results(await allEntries(opened.root))[0])).toBe("x: kept");
		await opened.harness.close(context);
	});

	it("abandons the parked children of a replay-unsafe call cut off while it ran", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		addTool(setup.registry, research);
		const nestedResults: string[] = [];
		addHooks(setup.registry, ToolTask, {
			afterTool: (hooked, result) => {
				if (hooked.parent !== undefined) nestedResults.push(...(result.diagnostics ?? []).map((d) => d.message));
				return undefined;
			},
		});
		const started = deferred();
		addTool(
			setup.registry,
			tool("unsafe", async (_args, api, ctx) => {
				await api.executeTool("research", { topic: "x" }, ctx, { key: "a", wait: false });
				started.resolve();
				await aborted(ctx.abortSignal!);
				return { output: [] };
			}),
		);
		setup.faux.setResponses([call("unsafe"), DONE]);
		const crashed = await open(setup, await openNodeSqliteStorage(path));
		const submissionId = (await crashed.root.submit({ type: "input", content: "go" }, context)).id;
		await started.promise;
		const parked = await parkedNested(crashed.harness, 1);
		// The process dies here: another one opens the same database.
		const next = await open(setup, await openNodeSqliteStorage(path));
		expect((await (await next.harness.submission(submissionId, context))!.wait(context)).status).toBe("done");
		const child = await next.harness.waitForTask(parked.get("c1/a")!, context);
		expect(child.abortReason).toBe("restart");
		expect(child.state.outcome.status).toBe("aborted");
		expect(nestedResults).toEqual(["Tool research was parked: its caller ended with a restart"]);
		const stored = (await next.harness.snapshot(LiveDoc, next.root.id, context))?.nestedTools;
		expect(stored).toBeUndefined();
		await next.harness.close(context);
		await crashed.harness.close(context);
	});
});

describe("submissions that notify a task", () => {
	/** Sleeps on `SubmissionSettled` under `settled`, then completes with the settled record's status. */
	const Waiter = defineTask<null, { phase: "sleep" } | { phase: "woke" }, string | null>({
		name: "test.waiter",
		version: 1,
		initial: () => ({ phase: "sleep" }),
		phases: {
			sleep: (_task, runtime, ctx) =>
				runtime.commit(
					() => ({
						status: "sleeping",
						checkpoint: { phase: "woke" },
						signals: [SubmissionSettled.key("settled")],
					}),
					ctx,
				),
			woke: async (_task, runtime, ctx) => {
				const state = await runtime.readSignal(SubmissionSettled, "settled", ctx);
				const status = state !== undefined && "value" in state ? state.value.status : null;
				await runtime.commit(() => completed(status), ctx);
			},
		},
		abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
	});

	it("deliver SubmissionSettled in the commit that settles the submission", async () => {
		const setup = chatSetup();
		addTask(setup.registry, Waiter);
		const gate = deferred();
		setup.faux.setResponses([
			async () => {
				await gate.promise;
				return fauxAssistantMessage([fauxText("answer")]);
			},
		]);
		const storage = new ControlledStorage();
		const { harness, root } = await open(setup, storage);
		const waiter = await root.commit(
			(tx) => tx.createTask(Waiter, null, { ownership: { kind: "conversation" } }),
			context,
		);
		await waitFor(async () => (await harness.getTask(waiter, context))?.state.status === "sleeping");
		const submission = await root.submit(
			{ type: "input", content: "go", notify: { taskId: waiter, key: "settled" } },
			context,
		);
		gate.resolve();
		expect((await submission.wait(context)).status).toBe("done");
		expect((await harness.waitForTask(waiter, context)).state.outcome).toEqual({
			status: "completed",
			result: "done",
		});
		// One batch settles the submission and stores the signal in the waiter.
		const settling = storage.commits.find((batch) =>
			batch.some(
				(write) => write.type === "submission" && write.value.id === submission.id && write.value.status === "done",
			),
		);
		const signalled = settling?.find((write) => write.type === "task" && write.value.id === waiter);
		expect(signalled?.type === "task" ? signalled.value.memos : undefined).toHaveProperty([
			"pi.signal.pi.submission-settled/settled",
		]);
		await harness.close(context);
	});

	it("deliver it for a submission created settled, before the task ran, which then wakes at once", async () => {
		const setup = chatSetup();
		const { harness, root } = await open(setup);
		// Blocked until its definition is installed, so it has not run when the write settles at its admission.
		const waiter = await root.commit(
			(tx) => tx.createTask(Waiter, null, { ownership: { kind: "conversation" } }),
			context,
		);
		const write = await root.submit(
			{ type: "write", entry: { kind: "test.note", data: "hi" }, notify: { taskId: waiter, key: "settled" } },
			context,
		);
		expect((await write.status(context)).status).toBe("done");
		expect((await harness.getTask(waiter, context))?.startedAt).toBeUndefined();
		addTask(setup.registry, Waiter);
		expect((await harness.waitForTask(waiter, context)).state.outcome).toEqual({
			status: "completed",
			result: "done",
		});
		await harness.close(context);
	});

	it("compose in one commit: two queued writes placed together signal one task under two keys", async () => {
		const setup = chatSetup();
		const gate = deferred();
		setup.faux.setResponses([
			async () => {
				await gate.promise;
				return fauxAssistantMessage([fauxText("answer")]);
			},
		]);
		const storage = new ControlledStorage();
		const { harness, root } = await open(setup, storage);
		const Two = defineTask<null, { phase: "sleep" } | { phase: "woke" }, null>({
			name: "test.two-keys",
			version: 1,
			initial: () => ({ phase: "sleep" }),
			phases: {
				sleep: (_task, runtime, ctx) =>
					runtime.commit(
						() => ({
							status: "sleeping",
							checkpoint: { phase: "woke" },
							signals: [SubmissionSettled.key("one"), SubmissionSettled.key("two")],
						}),
						ctx,
					),
				woke: (_task, runtime, ctx) => runtime.commit(() => completed(null), ctx),
			},
			abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
		});
		addTask(setup.registry, Two);
		const waiter = await root.commit(
			(tx) => tx.createTask(Two, null, { ownership: { kind: "conversation" } }),
			context,
		);
		await waitFor(async () => (await harness.getTask(waiter, context))?.state.status === "sleeping");
		// Busy: the writes, which the model sees, queue until the run's final boundary places both.
		const run = await root.submit({ type: "input", content: "go" }, context);
		const note = (key: string) =>
			root.submit(
				{
					type: "write",
					entry: { kind: "test.note", model: [{ role: "user", content: key, timestamp: 0 }] },
					notify: { taskId: waiter, key },
				},
				context,
			);
		const [one, two] = [await note("one"), await note("two")];
		gate.resolve();
		await run.wait(context);
		expect([(await one.wait(context)).status, (await two.wait(context)).status]).toEqual(["done", "done"]);
		const placing = storage.commits.find((batch) =>
			batch.some(
				(write) => write.type === "submission" && write.value.id === two.id && write.value.status === "done",
			),
		);
		// Both placed in this batch, and the waiter written once: one transaction composed both deliveries.
		expect(
			placing?.some(
				(write) => write.type === "submission" && write.value.id === one.id && write.value.status === "done",
			),
		).toBe(true);
		const writes = placing?.filter((write) => write.type === "task" && write.value.id === waiter) ?? [];
		expect(writes).toHaveLength(1);
		const [signalled] = writes;
		const memos = signalled?.type === "task" ? Object.keys(signalled.value.memos ?? {}) : [];
		expect(memos).toEqual(["pi.signal.pi.submission-settled/one", "pi.signal.pi.submission-settled/two"]);
		await harness.waitForTask(waiter, context);
		await harness.close(context);
	});

	it("refuse a delivery of SubmissionSettled that is no settled record", async () => {
		const setup = chatSetup();
		addTask(setup.registry, Waiter);
		const { harness, root } = await open(setup);
		const waiter = await root.commit(
			(tx) => tx.createTask(Waiter, null, { ownership: { kind: "conversation" } }),
			context,
		);
		expect(await harness.signal(waiter, SubmissionSettled, "settled", 17 as never, context)).toBe("invalid");
		// A done input without its entry and answer is no settled record either.
		const partial = { id: 2, conversationId: 1, type: "input", status: "done" };
		expect(await harness.signal(waiter, SubmissionSettled, "settled", partial as never, context)).toBe("invalid");
		const badEntry = { id: 2, conversationId: 1, type: "input", status: "unanswered", reason: "x", entry: "e1" };
		expect(await harness.signal(waiter, SubmissionSettled, "settled", badEntry as never, context)).toBe("invalid");
		await harness.abortTask(waiter, context);
		await harness.close(context);
	});

	it("settle without failing when the task to notify is gone", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([fauxAssistantMessage([fauxText("answer")])]);
		const { harness, root } = await open(setup);
		const submission = await root.submit(
			{ type: "input", content: "go", notify: { taskId: 999_999 as TaskId, key: "settled" } },
			context,
		);
		expect((await submission.wait(context)).status).toBe("done");
		await harness.close(context);
	});
});
