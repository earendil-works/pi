// Hooks that start tasks (spec suspendable §6): `afterTools` tasks that end the run or answer it with a steer, and
// `onYield` tasks that decide whether an answer stands while the run's inputs stay open.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AfterToolsDecision,
	defineExtension,
	defineSignal,
	defineTask,
	defineTool,
	GenerationTask,
	hook,
	hookTask,
	LiveDoc,
	MemoryStorage,
	type TaskId,
	type YieldDecision,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { afterEach, describe, expect, it } from "vitest";
import { settleSchedulerOutcome } from "../src/harness/live.ts";
import type { Transaction } from "../src/session/transaction.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { commitWrites } from "../src/testing/commit-writes.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf, waitFor } from "./chat-support.ts";
import { context } from "./session-support.ts";
import { aborted, completed, type Deferred, deferred } from "./task-support.ts";

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-hook-tasks-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

const CALL = fauxAssistantMessage([fauxToolCall("noop", {}, { id: "c1" })], { stopReason: "toolUse" });

/** What a hook task completes with, and an optional steer it submits in its terminal commit. */
type Plan = { result: AfterToolsDecision | YieldDecision | null; steer?: string; gate?: Deferred };

/** A task that waits for its plan's gate, submits its steer, and completes with its plan's result. */
function deciderTask(plan: Plan, seen: { yields: (number | undefined)[] }) {
	return defineTask<null, { phase: "decide" }, AfterToolsDecision | YieldDecision | null>({
		name: "test.decider",
		version: 1,
		initial: () => ({ phase: "decide" }),
		phases: {
			decide: async (_task, runtime, ctx) => {
				if (plan.gate !== undefined) await Promise.race([plan.gate.promise, aborted(runtime.signal)]);
				// The answer a yield task decides about is in `run.yield`.
				seen.yields.push((await runtime.snapshot(LiveDoc, runtime.conversationId, ctx))?.run?.yield?.answer);
				const handle = (await runtime.conversation(runtime.conversationId, ctx))!;
				await runtime.commit(async (tx) => {
					if (plan.steer !== undefined) {
						await handle.submit(tx, { type: "input", content: plan.steer, whenBusy: "steer" });
					}
					return completed(plan.result);
				}, ctx);
			},
		},
		abort: (_task, runtime, ctx) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
	});
}

function setupWith(hookName: "afterTools" | "onYield", plan: Plan) {
	const setup = chatSetup();
	const seen = { yields: [] as (number | undefined)[], asked: 0 };
	const Decider = deciderTask(plan, seen);
	const noop = defineTool({ name: "noop", description: "noop", parameters: obj({}), execute: async () => ({}) });
	const handler = async () => {
		seen.asked++;
		return seen.asked === 1 ? { tasks: [hookTask(Decider, null)] } : undefined;
	};
	setup.registry.install(
		defineExtension({
			name: "deciders",
			tools: [noop],
			tasks: [Decider],
			hooks: [hook(GenerationTask, { [hookName]: handler })],
		}),
	);
	return { setup, seen };
}

async function open(setup: ChatSetup) {
	const opened = await openChat(new MemoryStorage(), setup);
	opened.harness.resume();
	return opened;
}

async function texts(opened: Awaited<ReturnType<typeof open>>) {
	return (await allEntries(opened.root)).map((entry) => textOf(entry.model?.[0])).filter((text) => text !== undefined);
}

describe("afterTools tasks", () => {
	it("end the run with { terminate: true }, as a round whose calls all asked to terminate", async () => {
		const { setup } = setupWith("afterTools", { result: { terminate: true } });
		setup.faux.setResponses([CALL]);
		const opened = await open(setup);
		const settled = await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(settled.status).toBe("done");
		// Answered with the tool-calling answer; no further request.
		expect(settled.status === "done" && settled.type === "input" ? settled.answer : undefined).toBe(
			(await allEntries(opened.root)).find((entry) => entry.kind === "pi.assistant")?.id,
		);
		expect(setup.faux.state.callCount).toBe(1);
		await opened.harness.close(context);
	});

	it("answer the run with a steer the next request sees", async () => {
		const { setup } = setupWith("afterTools", { result: null, steer: "also check the tests" });
		setup.faux.setResponses([CALL, fauxAssistantMessage([fauxText("checked")])]);
		const opened = await open(setup);
		expect((await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe(
			"done",
		);
		expect(await texts(opened)).toEqual(["go", "also check the tests", "checked"]);
		await opened.harness.close(context);
	});

	it("report a result that is no AfterToolsDecision and go on", async () => {
		const { setup } = setupWith("afterTools", { result: { continue: "x" } });
		setup.faux.setResponses([CALL, fauxAssistantMessage([fauxText("done")])]);
		const opened = await open(setup);
		expect((await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe(
			"done",
		);
		expect(setup.infos).toContainEqual(expect.objectContaining({ kind: "extension_error", extension: "deciders" }));
		expect(setup.faux.state.callCount).toBe(2);
		await opened.harness.close(context);
	});
});

describe("onYield tasks", () => {
	it("keep the inputs open while they decide, and continue the run with { continue }", async () => {
		const gate = deferred();
		const { setup, seen } = setupWith("onYield", { result: { continue: "review: add a test" }, gate });
		setup.faux.setResponses([fauxAssistantMessage([fauxText("first")]), fauxAssistantMessage([fauxText("second")])]);
		const opened = await open(setup);
		const submission = await opened.root.submit({ type: "input", content: "go" }, context);
		await waitFor(
			async () => (await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.run?.yield !== undefined,
		);
		// The answer is appended, the input not yet answered.
		expect((await submission.status(context)).status).toBe("placed");
		gate.resolve();
		const settled = await submission.wait(context);
		expect(await texts(opened)).toEqual(["go", "first", "review: add a test", "second"]);
		const second = (await allEntries(opened.root)).at(-1)!.id;
		expect(settled.status === "done" && settled.type === "input" ? settled.answer : undefined).toBe(second);
		const first = (await allEntries(opened.root)).find((entry) => textOf(entry.model?.[0]) === "first")!.id;
		expect(seen.yields).toEqual([first]);
		await opened.harness.close(context);
	});

	it("ignore a continuation that holds no valid user input", async () => {
		for (const input of [5, [], [{ type: "text" }], [{ type: "image", data: "x" }]]) {
			const { setup } = setupWith("onYield", { result: { continue: input } as YieldDecision });
			setup.faux.setResponses([fauxAssistantMessage([fauxText("first")])]);
			const opened = await open(setup);
			expect(
				(await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context)).status,
			).toBe("done");
			expect(await texts(opened)).toEqual(["go", "first"]);
			await opened.harness.close(context);
		}
	});

	it("let an answer that stands run its afterRun tasks next, without run.yield", async () => {
		const { setup } = setupWith("onYield", { result: null });
		const asked: (unknown | undefined)[] = [];
		setup.registry.install(
			defineExtension({
				name: "after-run",
				hooks: [
					hook(GenerationTask, {
						afterRun: async (_run, api, ctx) => {
							asked.push((await api.snapshot(LiveDoc, api.conversationId, ctx))?.run?.yield);
							return undefined;
						},
					}),
				],
			}),
		);
		setup.faux.setResponses([fauxAssistantMessage([fauxText("first")])]);
		const opened = await open(setup);
		expect((await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe(
			"done",
		);
		await opened.root.waitForIdle(context);
		expect(asked).toEqual([undefined]);
		await opened.harness.close(context);
	});

	it("let the answer stand without a continuation", async () => {
		const { setup } = setupWith("onYield", { result: null });
		setup.faux.setResponses([fauxAssistantMessage([fauxText("first")])]);
		const opened = await open(setup);
		const settled = await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(settled.status).toBe("done");
		expect(await texts(opened)).toEqual(["go", "first"]);
		expect((await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.run).toBeUndefined();
		await opened.harness.close(context);
	});

	it("lose their continuation to a user message queued meanwhile", async () => {
		const gate = deferred();
		const { setup } = setupWith("onYield", { result: { continue: "review: add a test" }, gate });
		setup.faux.setResponses([fauxAssistantMessage([fauxText("first")]), fauxAssistantMessage([fauxText("to you")])]);
		const opened = await open(setup);
		const submission = await opened.root.submit({ type: "input", content: "go" }, context);
		await waitFor(
			async () => (await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.run?.yield !== undefined,
		);
		const queued = await opened.root.submit({ type: "input", content: "a question", whenBusy: "followUp" }, context);
		gate.resolve();
		expect((await submission.wait(context)).status).toBe("done");
		expect((await queued.wait(context)).status).toBe("done");
		expect(await texts(opened)).toEqual(["go", "first", "a question", "to you"]);
		await opened.harness.close(context);
	});

	it("settle the inputs done with the answer when the run is aborted while they decide", async () => {
		const gate = deferred();
		const { setup } = setupWith("onYield", { result: { continue: "never" }, gate });
		setup.faux.setResponses([fauxAssistantMessage([fauxText("first")])]);
		const opened = await open(setup);
		const submission = await opened.root.submit({ type: "input", content: "go" }, context);
		await waitFor(
			async () => (await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.run?.yield !== undefined,
		);
		await opened.root.abort(context);
		const settled = await submission.wait(context);
		expect(settled.status).toBe("done");
		const live = await opened.harness.snapshot(LiveDoc, opened.root.id, context);
		expect(live?.run).toBeUndefined();
		expect(live?.runFailure).toBeUndefined();
		await opened.harness.close(context);
	});
});

describe("recovery", () => {
	/** A decider that parks on `Go` until a delivery, then completes with `result`. */
	const Go = defineSignal({ name: "test.go", version: 1, schema: obj({}) });
	function parkingDecider(result: AfterToolsDecision | YieldDecision | null) {
		return defineTask<null, { phase: "park" } | { phase: "done" }, AfterToolsDecision | YieldDecision | null>({
			name: "test.parking-decider",
			version: 1,
			initial: () => ({ phase: "park" }),
			phases: {
				park: (_task, runtime, ctx) =>
					runtime.commit(
						() => ({ status: "sleeping", checkpoint: { phase: "done" }, signals: [Go.key("go")] }),
						ctx,
					),
				done: (_task, runtime, ctx) => runtime.commit(() => completed(result), ctx),
			},
			abort: (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
		});
	}

	it("asks the afterTools hooks again after a crash before their tasks exist, not after", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const Decider = parkingDecider(null);
		const gate = deferred();
		let asked = 0;
		const noop = defineTool({ name: "noop", description: "noop", parameters: obj({}), execute: async () => ({}) });
		setup.registry.install(
			defineExtension({
				name: "deciders",
				tools: [noop],
				tasks: [Decider],
				hooks: [
					hook(GenerationTask, {
						afterTools: async () => {
							asked++;
							// The first process dies while its hook runs.
							if (asked === 1) await gate.promise;
							return { tasks: [hookTask(Decider, null)] };
						},
					}),
				],
			}),
		);
		setup.faux.setResponses([CALL, fauxAssistantMessage([fauxText("done")])]);
		const crashed = await openChat(await openNodeSqliteStorage(path), setup);
		crashed.harness.resume();
		const id = (await crashed.root.submit({ type: "input", content: "go" }, context)).id;
		await waitFor(() => asked === 1);
		const next = await openChat(await openNodeSqliteStorage(path), setup);
		next.harness.resume();
		// Asked again: nothing was created before the crash.
		await waitFor(() => asked === 2);
		let decider: number | undefined;
		await waitFor(async () => {
			decider = (await next.harness.inspect(context)).tasks.find(
				(task) => task.record.kind === Decider.definition.name,
			)?.record.id;
			return (
				decider !== undefined &&
				(await next.harness.getTask(decider as never, context))?.state.status === "sleeping"
			);
		});
		// With the task waiting, the next process resumes the wait without asking.
		await next.harness.close(context);
		const third = await openChat(await openNodeSqliteStorage(path), setup);
		third.harness.resume();
		await third.harness.signal(decider as never, Go, "go", {}, context);
		expect((await (await third.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect(asked).toBe(2);
		await third.harness.close(context);
		gate.resolve();
		await crashed.harness.close(context);
	});

	it("settles a yield's inputs done with its answer at the restart limit, without a runFailure", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const Decider = parkingDecider({ continue: "never" });
		setup.registry.install(
			defineExtension({
				name: "deciders",
				tasks: [Decider],
				hooks: [hook(GenerationTask, { onYield: async () => ({ tasks: [hookTask(Decider, null)] }) })],
			}),
		);
		setup.faux.setResponses([fauxAssistantMessage([fauxText("first")])]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		let answer: number | undefined;
		await waitFor(async () => {
			answer = (await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.run?.yield?.answer;
			return answer !== undefined;
		});
		const generation = (await opened.harness.snapshot(LiveDoc, opened.root.id, context))!.run!.taskId;
		await opened.harness.close(context);
		// Cut off in `yield` as often as the limit allows: as a dead process leaves it, `running` with its count.
		const storage = await openNodeSqliteStorage(path);
		const record = (await storage.task(generation, context))!;
		const running = { ...record, state: { status: "running", checkpoint: record.state.checkpoint }, restarts: 5 };
		await commitWrites(storage, [{ type: "task", value: running as typeof record }], context);
		opened = await openChat(storage, setup);
		opened.harness.resume();
		const settled = await (await opened.harness.submission(id, context))!.wait(context);
		expect(settled.status === "done" && settled.type === "input" ? settled.answer : undefined).toBe(answer);
		const live = await opened.harness.snapshot(LiveDoc, opened.root.id, context);
		expect([live?.run, live?.runFailure]).toEqual([undefined, undefined]);
		await opened.harness.close(context);
	});

	it("settles a yield's inputs done with its answer when the scheduler ends the generation", async () => {
		const setup = chatSetup();
		const Decider = parkingDecider({ continue: "never" });
		setup.registry.install(
			defineExtension({
				name: "deciders",
				tasks: [Decider],
				hooks: [hook(GenerationTask, { onYield: async () => ({ tasks: [hookTask(Decider, null)] }) })],
			}),
		);
		setup.faux.setResponses([fauxAssistantMessage([fauxText("first")])]);
		const opened = await open(setup);
		const submission = await opened.root.submit({ type: "input", content: "go" }, context);
		await waitFor(
			async () => (await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.run?.yield !== undefined,
		);
		const live = (await opened.harness.snapshot(LiveDoc, opened.root.id, context))!;
		const generation = (await opened.harness.getTask(live.run!.taskId as TaskId<JsonValue>, context))!;
		// The Harness cleanup the scheduler stages with a `faulted` outcome it writes.
		await opened.harness.commit(
			(tx) =>
				settleSchedulerOutcome(tx as Transaction, generation, { status: "faulted", error: { message: "broken" } }),
			context,
		);
		const settled = await submission.wait(context);
		expect(settled.status === "done" && settled.type === "input" ? settled.answer : undefined).toBe(
			live.run!.yield!.answer,
		);
		expect((await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.runFailure).toBeUndefined();
		await opened.harness.close(context);
	});
});
