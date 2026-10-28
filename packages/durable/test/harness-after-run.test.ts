import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Draft, JsonValue } from "@earendil-works/chord";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	CompactionTask,
	ConversationBusy,
	type ConversationHandle,
	defineExtension,
	defineTask,
	defineTool,
	type EntryRecord,
	type GenerationHooks,
	GenerationTask,
	hook,
	InboxDoc,
	LiveDoc,
	type LiveState,
	MemoryStorage,
	type RunEndTask,
	type RunSummary,
	runEndTask,
	type Storage,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { endRun } from "../src/harness/live.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf } from "./chat-support.ts";
import { context } from "./session-support.ts";
import { aborted, completed, type Deferred, deferred, eventually, settled } from "./task-support.ts";

const directories = new Set<string>();
/** Storages of killed Harnesses, never closed by them: closed after each test. */
const killed = new Set<Storage>();

afterEach(async () => {
	for (const storage of killed) await storage.close(context).catch(() => {});
	killed.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-after-run-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

/** Open a chat over SQLite at `path`; `kill()` simulates a crash: every later storage call hangs, so nothing more lands. */
async function openKillable(path: string, setup: ChatSetup) {
	const inner = await openNodeSqliteStorage(path);
	let dead = false;
	const storage = new Proxy(inner, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => (dead ? new Promise(() => {}) : value.apply(target, args));
		},
	});
	const opened = await openChat(storage, setup);
	const kill = (): void => {
		dead = true;
		killed.add(inner);
	};
	return { ...opened, kill };
}

/** What the after-run task and hook of a test did, and how they behave. */
type Probe = {
	/** Labels of the after-run task's runs, in order, reruns included. */
	runs: string[];
	/** Summaries the `afterRun` hook was asked with. */
	asked: RunSummary[];
	aborted: number;
	/** Holds every run of the after-run task until resolved. */
	gate?: Deferred;
	/** Holds the hook until resolved. */
	hookGate?: Deferred;
	/** Admitted in the after-run task's commit, before its own entry. */
	admit?: (handle: ConversationHandle, tx: Tx) => Promise<unknown>;
};

function probe(): Probe {
	return { runs: [], asked: [], aborted: 0 };
}

/** The after-run task: records its run, waits for the gate, then appends a `test.tests` entry and completes. */
function testsTask(state: Probe) {
	return defineTask<{ label: string }, { phase: "run" }, string>({
		name: "test.run-tests",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, ctx) => {
				state.runs.push(task.input.label);
				if (state.gate !== undefined) await Promise.race([state.gate.promise, aborted(runtime.signal)]);
				const handle =
					state.admit === undefined ? undefined : await runtime.conversation(runtime.conversationId, ctx);
				await runtime.commit(async (tx) => {
					if (state.admit !== undefined) await state.admit(handle!, tx);
					await tx.appendEntry(runtime.conversationId, { kind: "test.tests", data: task.input.label });
					return completed(task.input.label);
				}, ctx);
			},
		},
		abort: async (_task, runtime, ctx) => {
			state.aborted++;
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }) as const, ctx);
		},
	});
}

/**
 * Install the after-run extension: its task and an `afterRun` hook, by default asking for one task per run. Returns
 * the task.
 */
function install(setup: ChatSetup, state: Probe, afterRun?: GenerationHooks["afterRun"]) {
	const Tests = testsTask(state);
	const handler: GenerationHooks["afterRun"] =
		afterRun ??
		(async (run) => {
			state.asked.push(run);
			if (state.hookGate !== undefined) await state.hookGate.promise;
			return { tasks: [runEndTask(Tests, { label: `run ${state.asked.length}` })] };
		});
	setup.registry.install(
		defineExtension({ name: "after-run", tasks: [Tests], hooks: [hook(GenerationTask, { afterRun: handler })] }),
	);
	return Tests;
}

const Parameters = Type.Object({});
const tools = defineExtension({
	name: "tools",
	tools: [
		defineTool({
			name: "edit",
			description: "Edit a file",
			parameters: Parameters,
			execute: async () => ({ output: [{ type: "text", text: "edited" }] }),
		}),
		defineTool({
			name: "finish",
			description: "End the run",
			parameters: Parameters,
			execute: async () => ({ output: [{ type: "text", text: "finished" }], control: { terminate: true } }),
		}),
		defineTool({
			name: "handoff",
			description: "End the run in a new context",
			parameters: Parameters,
			execute: async () => ({
				output: [{ type: "text", text: "handed off" }],
				control: { terminate: true, handoff: "fresh start" },
			}),
		}),
	],
});

function call(name: string, id: string) {
	return fauxAssistantMessage([fauxToolCall(name, {}, { id })], { stopReason: "toolUse" });
}

function kindOf(entries: readonly EntryRecord[], kind: string): EntryRecord[] {
	return entries.filter((entry) => entry.kind === kind);
}

/** Texts of the user messages of the conversation's entries, in order. */
function userTexts(entries: readonly EntryRecord[]): string[] {
	return entries.flatMap((entry) =>
		(entry.model ?? []).flatMap((message) => (message.role === "user" ? [textOf(message) ?? ""] : [])),
	);
}

describe("afterRun", () => {
	// #11141
	it("waits for the tasks an answer's hooks ask for: inputs done at the answer, the run busy until they end", async () => {
		const setup = chatSetup();
		const state = probe();
		state.gate = deferred();
		install(setup, state);
		setup.registry.install(tools);
		setup.faux.setResponses([call("edit", "a"), fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		// The input settles with the answer, before the task finishes.
		expect((await submission.wait(context)).status).toBe("done");
		await eventually(() => state.runs.length === 1);
		const live = (await harness.snapshot(LiveDoc, root.id, context))!;
		expect(live.run?.inputs).toEqual([]);
		expect(live.run?.afterRun?.tasks).toHaveLength(1);
		const child = await harness.getTask(live.run!.afterRun!.tasks![0]!, context);
		expect(child?.owner).toBe(live.run!.taskId);
		expect(child?.background).toBe(false);
		const idle = root.waitForIdle(context);
		expect(await settled(idle)).toBe(false);

		const entries = await allEntries(root);
		const answer = kindOf(entries, "pi.assistant").at(-1)!;
		expect(state.asked).toEqual([
			{ reason: "answer", first: kindOf(entries, "pi.user")[0]!.id, answer: answer.id, last: answer.id },
		]);
		state.gate.resolve();
		await idle;
		expect((await harness.snapshot(LiveDoc, root.id, context))?.run).toBeUndefined();
		expect((await harness.snapshot(LiveDoc, root.id, context))?.runFailure).toBeUndefined();
		expect((await allEntries(root)).at(-1)?.kind).toBe("test.tests");
		const generation = await harness.getTask(live.run!.taskId, context);
		expect(generation?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "completed", result: { entryId: answer.id } },
		});
		await harness.close(context);
	});

	// #11141
	it("asks after a terminate round, the run's last entry its newest result or its handoff's reset", async () => {
		for (const [tool, lastKind] of [
			["finish", "pi.tool-result"],
			["handoff", "pi.reset"],
		] as const) {
			const setup = chatSetup();
			const state = probe();
			install(setup, state);
			setup.registry.install(tools);
			setup.faux.setResponses([call(tool, "a")]);
			const { harness, root } = await openChat(new MemoryStorage(), setup);
			await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
			await root.waitForIdle(context);
			const entries = await allEntries(root);
			const assistant = kindOf(entries, "pi.assistant").at(-1)!;
			expect(state.asked).toEqual([
				{
					reason: "terminate",
					first: kindOf(entries, "pi.user")[0]!.id,
					answer: assistant.id,
					last: kindOf(entries, lastKind).at(-1)!.id,
				},
			]);
			expect(state.runs).toEqual(["run 1"]);
			expect((await harness.snapshot(LiveDoc, root.id, context))?.run).toBeUndefined();
			await harness.close(context);
		}
	});

	// #11141
	it("ends the run in one commit without an afterRun hook, and after the hook when it asks for nothing", async () => {
		const plain = chatSetup();
		const state = probe();
		plain.registry.install(defineExtension({ name: "tasks-only", tasks: [testsTask(state)] }));
		plain.faux.setResponses([fauxAssistantMessage("done")]);
		const opened = await openChat(new MemoryStorage(), plain);
		await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		// No hook: the answer's commit ended the run.
		expect(await opened.harness.snapshot(LiveDoc, opened.root.id, context)).toEqual({});
		await opened.harness.close(context);

		const setup = chatSetup();
		install(setup, state, async (run) => {
			state.asked.push(run);
			return undefined;
		});
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await root.waitForIdle(context);
		expect(state.asked).toHaveLength(1);
		expect(state.runs).toEqual([]);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		await harness.close(context);
	});

	// #11141
	it("queues input during the tasks and places it after them: writes first, then steers and follow-ups", async () => {
		const setup = chatSetup();
		const state = probe();
		state.gate = deferred();
		const Tests = testsTask(state);
		setup.registry.install(
			defineExtension({
				name: "after-run",
				tasks: [Tests],
				hooks: [
					hook(GenerationTask, {
						afterRun: async (run) => {
							state.asked.push(run);
							// Only the first run gets a task.
							return state.asked.length === 1 ? { tasks: [runEndTask(Tests, { label: "run 1" })] } : undefined;
						},
					}),
				],
			}),
		);
		// The task admits its result for the model in its own commit.
		state.admit = (handle, tx) =>
			handle.submit(tx, {
				type: "write",
				entry: { kind: "test.result", model: [{ role: "user", content: "tests passed", timestamp: 1 }] },
			});
		setup.faux.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("third"),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await eventually(() => state.runs.length === 1);

		const steer = await root.submit({ type: "input", content: "steer", whenBusy: "steer" }, context);
		const followUp = await root.submit({ type: "input", content: "later" }, context);
		await expect(root.submit({ type: "input", content: "x", whenBusy: "reject" }, context)).rejects.toBeInstanceOf(
			ConversationBusy,
		);
		await expect(root.submit({ type: "continue" }, context)).rejects.toBeInstanceOf(ConversationBusy);
		// Busy, so not idle: it queues and starts the next run after the tasks.
		const idleSteer = await root.submit(
			{ type: "input", content: "steer 2", whenBusy: "steer", whenIdle: "reject" },
			context,
		);
		const note = await root.submit({ type: "write", entry: { kind: "test.note" } }, context);
		expect((await note.status(context)).status).toBe("done");
		expect((await steer.status(context)).status).toBe("queued");
		expect(await harness.snapshot(InboxDoc, root.id, context)).toMatchObject({ items: { length: 3 } });

		state.gate.resolve();
		await root.waitForIdle(context);
		for (const submission of [steer, followUp, idleSteer]) {
			expect((await submission.wait(context)).status).toBe("done");
		}
		const entries = await allEntries(root);
		const kinds = entries.filter((entry) => entry.kind !== "pi.system").map((entry) => entry.kind);
		expect(kinds).toEqual([
			"pi.user",
			"pi.assistant",
			"test.note",
			"test.tests",
			"test.result",
			"pi.user",
			"pi.user",
			"pi.assistant",
			"pi.user",
			"pi.assistant",
		]);
		expect(userTexts(entries)).toEqual(["go", "tests passed", "steer", "later", "steer 2"]);
		await harness.close(context);
	});

	// #11141
	it("places a reset queued during the tasks after them", async () => {
		const setup = chatSetup();
		const state = probe();
		state.gate = deferred();
		install(setup, state);
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await eventually(() => state.runs.length === 1);
		await root.reset(undefined, context);
		expect(kindOf(await allEntries(root), "pi.reset")).toEqual([]);
		state.gate.resolve();
		await root.waitForIdle(context);
		const kinds = (await allEntries(root)).map((entry) => entry.kind);
		expect(kinds.slice(-2)).toEqual(["test.tests", "pi.reset"]);
		await harness.close(context);
	});

	// #11141
	it("asks once a run really ends: not while onYield continues it, and when a queued steer drops the continuation", async () => {
		const setup = chatSetup();
		const state = probe();
		install(setup, state);
		let yields = 0;
		setup.registry.install(
			defineExtension({
				name: "again",
				hooks: [hook(GenerationTask, { onYield: async () => (++yields <= 2 ? { continue: "again" } : undefined) })],
			}),
		);
		setup.faux.setResponses([fauxAssistantMessage("1"), fauxAssistantMessage("2"), fauxAssistantMessage("3")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await root.waitForIdle(context);
		const entries = await allEntries(root);
		expect(state.asked).toEqual([
			{
				reason: "answer",
				first: kindOf(entries, "pi.user")[0]!.id,
				answer: kindOf(entries, "pi.assistant").at(-1)!.id,
				last: kindOf(entries, "pi.assistant").at(-1)!.id,
			},
		]);
		await harness.close(context);

		// A steer queued while the answer's hooks run: the continuation is dropped, and the run ends after its task.
		const dropped = chatSetup();
		const second = probe();
		install(dropped, second);
		let root2: Awaited<ReturnType<typeof openChat>>["root"] | undefined;
		dropped.registry.install(
			defineExtension({
				name: "steering",
				hooks: [
					hook(GenerationTask, {
						onYield: async () => {
							if (second.asked.length > 0) return undefined;
							await root2!.submit({ type: "input", content: "steer", whenBusy: "steer" }, context);
							return { continue: "again" };
						},
					}),
				],
			}),
		);
		dropped.faux.setResponses([fauxAssistantMessage("1"), fauxAssistantMessage("2")]);
		const opened = await openChat(new MemoryStorage(), dropped);
		root2 = opened.root;
		await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		await opened.root.waitForIdle(context);
		expect(second.asked).toHaveLength(2);
		expect(second.runs).toEqual(["run 1", "run 2"]);
		expect(userTexts(await allEntries(opened.root))).toEqual(["go", "steer"]);
		await opened.harness.close(context);
	});

	// #11141
	it("asks the hooks again after a crash before the tasks exist, and never once they do", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const state = probe();
		state.hookGate = deferred();
		install(setup, state);
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		let opened = await openKillable(path, setup);
		await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		await eventually(() => state.asked.length === 1);
		opened.kill(); // a crash while the hook runs, in `finish`
		state.hookGate = undefined;
		state.gate = deferred();
		opened = await openKillable(path, setup);
		opened.harness.resume();
		await eventually(() => state.runs.length === 1);
		expect(state.asked).toHaveLength(2);
		opened.kill(); // a crash while the task runs, in `drain`
		state.gate = undefined;
		opened = await openKillable(path, setup);
		await opened.root.waitForIdle(context);
		// The task ran again; the hook was not asked again, and only one task exists.
		expect(state.asked).toHaveLength(2);
		expect(state.runs).toEqual(["run 2", "run 2"]);
		expect(kindOf(await allEntries(opened.root), "test.tests")).toHaveLength(1);
		const tasks = (await opened.harness.inspect(context)).tasks;
		expect(tasks).toEqual([]);
		await opened.harness.close(context);

		// An orderly close in `drain` resumes the same way.
		const closing = await sqlitePath();
		const other = probe();
		other.gate = deferred();
		const setup2 = chatSetup();
		install(setup2, other);
		setup2.faux.setResponses([fauxAssistantMessage("done")]);
		let reopened = await openKillable(closing, setup2);
		await (await reopened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		await eventually(() => other.runs.length === 1);
		await reopened.harness.close(context);
		other.gate = undefined;
		reopened = await openKillable(closing, setup2);
		await reopened.root.waitForIdle(context);
		expect(other.asked).toHaveLength(1);
		expect(other.runs).toEqual(["run 1", "run 1"]);
		await reopened.harness.close(context);
	});

	// #11141
	it("ends an answered run without a failure when Stop comes while the hooks run or the tasks run", async () => {
		for (const stage of ["finish", "drain"] as const) {
			const setup = chatSetup();
			const state = probe();
			const Tests = testsTask(state);
			state.gate = deferred();
			setup.registry.install(
				defineExtension({
					name: "after-run",
					tasks: [Tests],
					hooks: [
						hook(GenerationTask, {
							afterRun: async (run, _api, ctx) => {
								state.asked.push(run);
								if (stage === "finish") await aborted(ctx.abortSignal!);
								return { tasks: [runEndTask(Tests, { label: "run 1" })] };
							},
						}),
					],
				}),
			);
			setup.faux.setResponses([fauxAssistantMessage("done")]);
			const { harness, root } = await openChat(new MemoryStorage(), setup);
			const submission = await root.submit({ type: "input", content: "go" }, context);
			await submission.wait(context);
			await eventually(() => (stage === "finish" ? state.asked.length === 1 : state.runs.length === 1));
			await root.abort(context);
			const live = await harness.snapshot(LiveDoc, root.id, context);
			expect(live?.run).toBeUndefined();
			expect(live?.runFailure).toBeUndefined();
			expect((await submission.status(context)).status).toBe("done");
			expect(state.aborted).toBe(stage === "drain" ? 1 : 0);
			expect(state.runs).toEqual(stage === "drain" ? ["run 1"] : []);
			await harness.close(context);
		}
	});

	// #11141
	it("ends the run normally when one of its tasks is aborted on its own", async () => {
		const setup = chatSetup();
		const state = probe();
		state.gate = deferred();
		install(setup, state);
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await eventually(() => state.runs.length === 1);
		const live = (await harness.snapshot(LiveDoc, root.id, context))!;
		await harness.abortTask(live.run!.afterRun!.tasks![0]!, context);
		await root.waitForIdle(context);
		expect(state.aborted).toBe(1);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		expect((await harness.getTask(live.run!.taskId, context))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "completed" },
		});
		await harness.close(context);
	});

	// #11141
	it("reports broken requests and hooks and creates the rest", async () => {
		const setup = chatSetup();
		const state = probe();
		const Tests = testsTask(state);
		const Throwing = defineTask<null, { phase: "run" }, null>({
			name: "test.throwing",
			version: 1,
			initial: () => {
				throw new Error("initial failed");
			},
			phases: { run: async () => {} },
			abort: async () => {},
		});
		// Its `initial()` starts at a phase the definition does not have.
		const BadStart = defineTask<null, { phase: "run" }, null>({
			name: "test.bad-start",
			version: 1,
			initial: () => ({ phase: "nowhere" }) as unknown as { phase: "run" },
			phases: { run: async () => {} },
			abort: async () => {},
		});
		const requests: RunEndTask[] = [
			{ task: { definition: { ...Tests.definition, name: "test.unknown" } }, input: null },
			{ task: GenerationTask, input: {} },
			{ task: Tests, input: { label: () => "not JSON" } as unknown as JsonValue },
			runEndTask(Throwing, null),
			runEndTask(BadStart, null),
			runEndTask(Tests, { label: "ok" }),
		];
		setup.registry.install(
			defineExtension({
				name: "after-run",
				tasks: [Tests, Throwing, BadStart],
				hooks: [hook(GenerationTask, { afterRun: async () => ({ tasks: requests }) })],
			}),
		);
		setup.registry.install(
			defineExtension({
				name: "broken",
				hooks: [
					hook(GenerationTask, {
						afterRun: async () => {
							throw new Error("hook failed");
						},
					}),
				],
			}),
		);
		setup.registry.install(
			defineExtension({
				name: "not-a-list",
				hooks: [hook(GenerationTask, { afterRun: async () => ({ tasks: "x" as unknown as RunEndTask[] }) })],
			}),
		);
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await root.waitForIdle(context);
		expect(state.runs).toEqual(["ok"]);
		// One report per hook, against the hook's extension; the requests of one hook come together.
		expect(setup.infos.filter((info) => info.kind === "extension_error")).toEqual([
			expect.objectContaining({ extension: "after-run" }),
			expect.objectContaining({ extension: "broken" }),
			expect.objectContaining({ extension: "not-a-list" }),
		]);
		const rejected = setup.reports[0] as AggregateError;
		expect(rejected.errors.map((error: Error) => error.message)).toEqual([
			"Task test.unknown is not installed",
			"An afterRun hook cannot start the built-in task pi.generation",
			"Value contains a non-JSON function; expected strict JSON",
			"initial failed",
			"Task test.bad-start starts at the unknown phase nowhere",
		]);
		expect((setup.reports[1] as Error).message).toBe("hook failed");
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		await harness.close(context);
	});

	// #11141
	it("creates a requested task from the installed definition, calling its initial() once, off the line", async () => {
		const setup = chatSetup();
		const calls = { installed: 0, token: 0 };
		const define = (version: number, count: () => void) =>
			defineTask<null, { phase: "run" }, null>({
				name: "test.versioned",
				version,
				initial: () => {
					count();
					return { phase: "run" };
				},
				phases: { run: async (_task, runtime, ctx) => runtime.commit(() => completed(null), ctx) },
				abort: async () => {},
			});
		const Installed = define(2, () => calls.installed++);
		// The hook's extension holds an older copy of the task.
		const Stale = define(1, () => calls.token++);
		setup.registry.install(defineExtension({ name: "tasks", tasks: [Installed] }));
		setup.registry.install(
			defineExtension({
				name: "asker",
				hooks: [hook(GenerationTask, { afterRun: async () => ({ tasks: [runEndTask(Stale, null)] }) })],
			}),
		);
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await root.waitForIdle(context);
		const created = await harness.commit(
			(tx) => tx.scanTasks({ conversationId: root.id, kind: "test.versioned" }, 10),
			context,
		);
		expect(created.items).toHaveLength(1);
		expect(created.items[0]).toMatchObject({ version: 2, state: { status: "terminal" } });
		expect(calls).toEqual({ installed: 1, token: 0 });
		await harness.close(context);
	});

	// #11141
	it("lets a hook read the run's history, tool results included", async () => {
		const setup = chatSetup();
		const kinds: string[] = [];
		setup.registry.install(tools);
		setup.registry.install(
			defineExtension({
				name: "reader",
				hooks: [
					hook(GenerationTask, {
						afterRun: async (run, api, ctx) => {
							const page = await api.entries(
								{ minEntryId: run.first, maxEntryId: run.last, order: "ascending" },
								100,
								undefined,
								ctx,
							);
							kinds.push(...page.items.map((entry) => entry.kind));
							expect((await api.entry(run.answer, ctx))?.kind).toBe("pi.assistant");
							return undefined;
						},
					}),
				],
			}),
		);
		setup.faux.setResponses([call("edit", "a"), fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await root.waitForIdle(context);
		expect(kinds.filter((kind) => kind !== "pi.system")).toEqual([
			"pi.user",
			"pi.assistant",
			"pi.tool-result",
			"pi.assistant",
		]);
		await harness.close(context);
	});

	// #11141
	it("lets a hook read the run's history after a compaction summarized the start of the run", async () => {
		const setup = chatSetup();
		setup.settings.compaction = { enabled: false, reserveTokens: 1000, keepRecentTokens: 1, backgroundTokens: 0 };
		const gate = deferred();
		const started = deferred();
		const runs: string[][] = [];
		setup.registry.install(
			defineExtension({
				name: "slow",
				tools: [
					defineTool({
						name: "edit",
						description: "Edit a file",
						parameters: Parameters,
						execute: async () => {
							started.resolve();
							await gate.promise;
							return { output: [{ type: "text", text: "edited" }] };
						},
					}),
				],
				hooks: [
					hook(CompactionTask, { beforeCompact: async () => ({ summary: "earlier work" }) }),
					hook(GenerationTask, {
						afterRun: async (run, api, ctx) => {
							const page = await api.entries(
								{ minEntryId: run.first, maxEntryId: run.last, order: "ascending" },
								100,
								undefined,
								ctx,
							);
							runs.push(page.items.map((entry) => entry.kind));
							return undefined;
						},
					}),
				],
			}),
		);
		setup.faux.setResponses([call("edit", "a"), fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await started.promise;
		// Its summary is placed at the round's post-tools boundary, in the middle of the run.
		const compaction = await root.compact(undefined, context);
		await harness.waitForTask(compaction, context);
		gate.resolve();
		await submission.wait(context);
		await root.waitForIdle(context);
		const active = (await root.context(context)).entries.map((entry) => entry.kind);
		// The active context lost the run's input to the summary; the run's history did not.
		expect(active).not.toContain("pi.user");
		expect(runs).toHaveLength(1);
		expect(runs[0]!.filter((kind) => kind !== "pi.system")).toEqual([
			"pi.user",
			"pi.assistant",
			"pi.tool-result",
			"pi.compaction",
			"pi.assistant",
		]);
		await harness.close(context);
	});

	// #11141
	it("ends an answered run completed, without a failure, once finish was cut off restartLimit times", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		setup.settings.restartLimit = 1;
		const state = probe();
		state.hookGate = deferred();
		install(setup, state);
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		let opened = await openKillable(path, setup);
		await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		await eventually(() => state.asked.length === 1);
		await opened.root.submit({ type: "input", content: "later" }, context);
		opened.kill();
		opened = await openKillable(path, setup);
		await opened.root.waitForIdle(context);
		expect(state.asked).toHaveLength(1);
		const live = await opened.harness.snapshot(LiveDoc, opened.root.id, context);
		expect(live?.run).toBeUndefined();
		expect(live?.runFailure).toBeUndefined();
		// Queued items stay, as after a failed run.
		expect((await opened.harness.snapshot(InboxDoc, opened.root.id, context))?.items).toHaveLength(1);
		expect(setup.infos).toContainEqual(
			expect.objectContaining({ kind: "task_interrupted", reason: "restart_limit" }),
		);
		await opened.harness.close(context);
	});

	// #11141
	it("keeps the run busy while an after-run task cannot run, until Stop orphans it", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const state = probe();
		state.gate = deferred();
		install(setup, state);
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		let opened = await openKillable(path, setup);
		await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		await eventually(() => state.runs.length === 1);
		opened.kill();
		// Reopened without the extension: its task is blocked.
		const bare = chatSetup();
		opened = await openKillable(path, bare);
		opened.harness.resume();
		const live = (await opened.harness.snapshot(LiveDoc, opened.root.id, context))!;
		expect(live.run?.afterRun?.tasks).toHaveLength(1);
		await eventually(async () =>
			(await opened.harness.inspect(context)).tasks.some((task) => task.state.kind === "blocked"),
		);
		expect(await settled(opened.root.waitForIdle(context))).toBe(false);
		await opened.root.abort(context);
		const after = await opened.harness.snapshot(LiveDoc, opened.root.id, context);
		expect(after?.run).toBeUndefined();
		expect(after?.runFailure).toBeUndefined();
		expect((await opened.harness.getTask(live.run!.afterRun!.tasks![0]!, context))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "orphaned" },
		});
		await opened.harness.close(context);
	});

	// #11141
	it("starts a fix run with a follow-up a task admits, after the tasks", async () => {
		const setup = chatSetup();
		const state = probe();
		const Tests = testsTask(state);
		setup.registry.install(
			defineExtension({
				name: "after-run",
				tasks: [Tests],
				hooks: [
					hook(GenerationTask, {
						afterRun: async (run) => {
							state.asked.push(run);
							return state.asked.length === 1 ? { tasks: [runEndTask(Tests, { label: "run 1" })] } : undefined;
						},
					}),
				],
			}),
		);
		state.admit = (handle, tx) =>
			handle.submit(tx, { type: "input", content: "fix the tests", requestId: "fix-1", whenBusy: "followUp" });
		setup.faux.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("fixed")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await root.waitForIdle(context);
		const entries = await allEntries(root);
		expect(entries.filter((entry) => entry.kind !== "pi.system").map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.assistant",
			"test.tests",
			"pi.user",
			"pi.assistant",
		]);
		expect(userTexts(entries)).toEqual(["go", "fix the tests"]);
		expect(state.asked).toHaveLength(2);
		// The fix run's history starts with its own input.
		expect(state.asked[1]!.first).toBe(kindOf(entries, "pi.user")[1]!.id);
		await harness.close(context);
	});

	// #11141
	it("gives a continue after a failed run the failed run's history", async () => {
		const setup = chatSetup();
		const state = probe();
		install(setup, state);
		setup.registry.install(tools);
		setup.faux.setResponses([call("edit", "a"), fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.configure({ maxTurns: 1 }, context);
		const failed = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(failed.status).toBe("unanswered");
		const user = kindOf(await allEntries(root), "pi.user")[0]!;
		expect((await harness.snapshot(LiveDoc, root.id, context))?.runFailure).toMatchObject({
			reason: "turn_limit",
			first: user.id,
		});
		expect(state.asked).toEqual([]);
		await harness.commit((tx) => root.submit(tx, { type: "continue" }), context);
		await root.waitForIdle(context);
		const answer = kindOf(await allEntries(root), "pi.assistant").at(-1)!;
		expect(state.asked).toEqual([{ reason: "answer", first: user.id, answer: answer.id, last: answer.id }]);
		await harness.close(context);
	});

	// #11141
	it("ends the run without asking when the hooks are deselected before finish runs", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const state = probe();
		state.hookGate = deferred();
		install(setup, state);
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		let opened = await openKillable(path, setup);
		await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		await eventually(() => state.asked.length === 1);
		opened.kill();
		setup.registry.uninstall(defineExtension({ name: "after-run" }));
		opened = await openKillable(path, setup);
		await opened.root.waitForIdle(context);
		expect(state.asked).toHaveLength(1);
		expect(state.runs).toEqual([]);
		expect(await opened.harness.snapshot(LiveDoc, opened.root.id, context)).toEqual({});
		await opened.harness.close(context);
	});

	// #11141
	it("starts a fork of a conversation running its after-run tasks idle", async () => {
		const setup = chatSetup();
		const state = probe();
		state.gate = deferred();
		install(setup, state);
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await eventually(() => state.runs.length === 1);
		await root.submit({ type: "input", content: "later" }, context);
		const answer = kindOf(await allEntries(root), "pi.assistant").at(-1)!;
		const fork = await root.fork(answer.id, { ownership: { kind: "ownerless" } }, context);
		expect((await harness.snapshot(LiveDoc, fork.id, context))?.run).toBeUndefined();
		expect((await harness.snapshot(InboxDoc, fork.id, context))?.items ?? []).toEqual([]);
		state.gate.resolve();
		await root.waitForIdle(context);
		await harness.close(context);
	});

	// #11141
	it("gives a run without a recorded first entry its answer as first", async () => {
		const setup = chatSetup();
		const state = probe();
		install(setup, state);
		let root: Awaited<ReturnType<typeof openChat>>["root"] | undefined;
		setup.registry.install(
			defineExtension({
				name: "legacy",
				hooks: [
					hook(GenerationTask, {
						// As a run started before `first` existed.
						onYield: async () => {
							await root!.commit(async (tx) => {
								delete (await tx.doc(LiveDoc, root!.id)).run!.first;
							}, context);
							return undefined;
						},
					}),
				],
			}),
		);
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		const opened = await openChat(new MemoryStorage(), setup);
		root = opened.root;
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await root.waitForIdle(context);
		const answer = kindOf(await allEntries(root), "pi.assistant").at(-1)!;
		expect(state.asked).toEqual([{ reason: "answer", first: answer.id, answer: answer.id, last: answer.id }]);
		await opened.harness.close(context);
	});

	// #11141
	it("ends the run normally when its after-run task is cut off restartLimit times", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		setup.settings.restartLimit = 1;
		const state = probe();
		state.gate = deferred();
		install(setup, state);
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		let opened = await openKillable(path, setup);
		await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		await eventually(() => state.runs.length === 1);
		const generation = (await opened.harness.snapshot(LiveDoc, opened.root.id, context))!.run!.taskId;
		// The task is cut off, and the waiting generation is not: the scheduler faults the task, and the run ends.
		opened.kill();
		state.gate = undefined;
		opened = await openKillable(path, setup);
		await opened.root.waitForIdle(context);
		expect((await opened.harness.getTask(generation, context))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "completed" },
		});
		expect((await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.runFailure).toBeUndefined();
		expect(state.runs).toEqual(["run 1"]);
		expect(setup.infos).toContainEqual(expect.objectContaining({ kind: "task_faulted", reason: "restart_limit" }));
		await opened.harness.close(context);
	});

	// #11141
	it("reports no task_interrupted for a task that ends normally after the limit was lowered", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const state = { started: 0 };
		const Worker = defineTask<null, { phase: "run" }, null>({
			name: "test.worker",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, ctx) => {
					state.started++;
					if (state.started === 1) return new Promise(() => {}); // the run a crash cuts off
					// The host lowers the limit while the rerun runs.
					setup.settings.restartLimit = 1;
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: async () => {},
		});
		setup.registry.install(defineExtension({ name: "worker", tasks: [Worker] }));
		let opened = await openKillable(path, setup);
		const id = await opened.root.commit(
			(tx) => tx.createTask(Worker, null, { ownership: { kind: "conversation" } }),
			context,
		);
		opened.harness.resume();
		await eventually(() => state.started === 1);
		opened.kill();
		opened = await openKillable(path, setup);
		expect((await opened.harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
		expect(setup.infos.filter((info) => info.kind === "task_interrupted")).toEqual([]);
		setup.settings.restartLimit = undefined;
		await opened.harness.close(context);
	});

	// #11141
	it("reports no task_interrupted for a generation that ends normally after the limit was lowered in finish", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const state = probe();
		state.hookGate = deferred();
		install(setup, state);
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		let opened = await openKillable(path, setup);
		await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		await eventually(() => state.asked.length === 1);
		opened.kill(); // `finish` cut off once
		const rerun = deferred();
		state.hookGate = rerun;
		opened = await openKillable(path, setup);
		opened.harness.resume();
		await eventually(() => state.asked.length === 2);
		// The host lowers the limit while the hook runs; the phase had started under the old one and ends normally.
		setup.settings.restartLimit = 1;
		rerun.resolve();
		await opened.root.waitForIdle(context);
		expect(state.runs).toEqual(["run 2"]);
		expect(setup.infos.filter((info) => info.kind === "task_interrupted")).toEqual([]);
		await opened.harness.close(context);
	});

	// #11141
	it("asks after a terminate round at the turn limit: terminate wins", async () => {
		const setup = chatSetup();
		const state = probe();
		install(setup, state);
		setup.registry.install(tools);
		setup.faux.setResponses([call("finish", "a")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.configure({ maxTurns: 1 }, context);
		expect((await (await root.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe("done");
		await root.waitForIdle(context);
		expect(state.asked).toMatchObject([{ reason: "terminate" }]);
		expect(state.runs).toEqual(["run 1"]);
		expect((await harness.snapshot(LiveDoc, root.id, context))?.runFailure).toBeUndefined();
		await harness.close(context);
	});

	// #11141
	it("starts a continue's history at its first tool round when nothing failed and nothing was placed", async () => {
		const setup = chatSetup();
		const kinds: string[][] = [];
		setup.registry.install(tools);
		setup.registry.install(
			defineExtension({
				name: "reader",
				hooks: [
					hook(GenerationTask, {
						afterRun: async (run, api, ctx) => {
							const range = { minEntryId: run.first, maxEntryId: run.last, order: "ascending" } as const;
							kinds.push((await api.entries(range, 100, undefined, ctx)).items.map((entry) => entry.kind));
							return undefined;
						},
					}),
				],
			}),
		);
		setup.faux.setResponses([call("edit", "a"), fauxAssistantMessage("done")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		// A host writes the user message itself, then continues.
		await root.submit(
			{ type: "write", entry: { kind: "app.prompt", model: [{ role: "user", content: "go", timestamp: 1 }] } },
			context,
		);
		await (await root.submit({ type: "continue" }, context)).wait(context);
		await root.waitForIdle(context);
		expect(kinds).toEqual([["pi.assistant", "pi.tool-result", "pi.assistant"]]);
		await harness.close(context);
	});

	// #11141
	it("leaves a summary queued during the tasks stale behind a terminate round's handoff", async () => {
		const setup = chatSetup();
		setup.settings.compaction = { enabled: false, reserveTokens: 1000, keepRecentTokens: 1, backgroundTokens: 0 };
		const state = probe();
		install(setup, state);
		const gate = deferred();
		const started = deferred();
		setup.registry.install(
			defineExtension({
				name: "slow-handoff",
				tools: [
					defineTool({
						name: "handoff",
						description: "End the run in a new context",
						parameters: Parameters,
						execute: async () => {
							started.resolve();
							await gate.promise;
							return {
								output: [{ type: "text", text: "handed off" }],
								control: { terminate: true, handoff: "fresh start" },
							};
						},
					}),
				],
				hooks: [hook(CompactionTask, { beforeCompact: async () => ({ summary: "earlier work" }) })],
			}),
		);
		setup.faux.setResponses([call("handoff", "a")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await started.promise;
		const compaction = await root.compact(undefined, context);
		await harness.waitForTask(compaction, context);
		gate.resolve();
		await submission.wait(context);
		await root.waitForIdle(context);
		const entries = await allEntries(root);
		// The handoff's reset landed with the answer; the summary, cutting before it, settled stale at the run's end.
		expect(kindOf(entries, "pi.compaction")).toEqual([]);
		expect(entries.map((entry) => entry.kind).slice(-2)).toEqual(["pi.reset", "test.tests"]);
		expect(state.asked[0]).toMatchObject({ reason: "terminate", last: kindOf(entries, "pi.reset")[0]!.id });
		await harness.close(context);
	});

	// #11141
	it("stores the answer's held progress with commit A, and asks again after an orderly close in finish", async () => {
		const path = await sqlitePath();
		const setup = chatSetup({ tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } });
		setup.settings.progress = { persistWithinMs: Number.POSITIVE_INFINITY };
		const state = probe();
		const Tests = testsTask(state);
		let hookGate: Deferred | undefined = deferred();
		setup.registry.install(
			defineExtension({
				name: "after-run",
				tasks: [Tests],
				hooks: [
					hook(GenerationTask, {
						afterRun: async (run, _api, ctx) => {
							state.asked.push(run);
							if (hookGate !== undefined) await Promise.race([hookGate.promise, aborted(ctx.abortSignal!)]);
							return { tasks: [runEndTask(Tests, { label: "run" })] };
						},
					}),
				],
			}),
		);
		setup.faux.setResponses([fauxAssistantMessage("x".repeat(40))]);
		let opened = await openKillable(path, setup);
		await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		await eventually(() => state.asked.length === 1);
		opened.kill();
		opened = await openKillable(path, setup);
		const stored = (await opened.harness.snapshot(LiveDoc, opened.root.id, context))!;
		expect(stored.generation).toBeUndefined();
		expect(stored.run?.afterRun).toEqual({});
		expect(textOf(kindOf(await allEntries(opened.root), "pi.assistant")[0]!.model![0])).toBe("x".repeat(40));
		opened.harness.resume();
		await eventually(() => state.asked.length === 2);
		await opened.harness.close(context);
		hookGate = undefined;
		opened = await openKillable(path, setup);
		await opened.root.waitForIdle(context);
		expect(state.asked).toHaveLength(3);
		expect(state.runs).toEqual(["run"]);
		await opened.harness.close(context);
	});
});

describe("endRun", () => {
	const tx = { settleSubmission: () => {} } as unknown as Tx;

	// #11141
	it("leaves a run it does not own alone, and ends an answered run without a failure", () => {
		const live = {
			run: { taskId: 1 as TaskId, inputs: [], turns: 0, afterRun: { tasks: [5 as TaskId] } },
		} as unknown as Draft<LiveState>;
		endRun(tx, live, 2 as TaskId, { status: "unanswered", reason: "faulted" });
		expect(live.run?.afterRun).toEqual({ tasks: [5] });
		endRun(tx, live, 1 as TaskId, { status: "unanswered", reason: "aborted" });
		expect(live.run).toBeUndefined();
		expect(live.runFailure).toBeUndefined();
	});

	// #11141
	it("copies a failed run's first entry into runFailure", () => {
		const live = { run: { taskId: 1 as TaskId, inputs: [], turns: 0, first: 7 } } as unknown as Draft<LiveState>;
		endRun(tx, live, 1 as TaskId, { status: "unanswered", reason: "model_error" });
		expect(live.runFailure).toMatchObject({ reason: "model_error", first: 7 });
	});
});
