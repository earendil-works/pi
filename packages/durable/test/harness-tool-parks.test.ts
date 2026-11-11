// Tools that park (spec suspendable §4): a sleep on signals or time, a wait on owned tasks, the parked slot, the run
// after the wake, invalid parks, cleanup through `cancel`, recovery, and wrappers.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineSignal,
	defineTask,
	defineTool,
	type EntryRecord,
	type Harness,
	LiveDoc,
	MemoryStorage,
	type Storage,
	type TaskId,
	type ToolPark,
	type ToolRegistration,
	ToolResultEntry,
	type WakeReason,
	wrapTool,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionEnv } from "../src/env/index.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, waitFor } from "./chat-support.ts";
import { addTask, addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, abortedWith, completed, deferred } from "./task-support.ts";

const Done = defineSignal({ name: "test.done", version: 1, schema: obj({ text: str() }) });

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-parks-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

function tool(
	name: string,
	execute: ToolRegistration["execute"],
	extra: Partial<ToolRegistration> = {},
): ToolRegistration {
	return defineTool({ name, description: name, parameters: obj({}), execute, ...extra });
}

function call(name: string, id = "c1"): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, {}, { id })], { stopReason: "toolUse" });
}

const DONE = fauxAssistantMessage([fauxText("done")]);

function results(entries: readonly EntryRecord[]): ToolResultMessage[] {
	return entries.filter((entry) => ToolResultEntry.is(entry)).map((entry) => entry.model![0] as ToolResultMessage);
}

function text(message: ToolResultMessage | undefined): string {
	return (message?.content ?? []).map((item) => (item.type === "text" ? item.text : "")).join("|");
}

/** The first tool slot of the root conversation. */
async function slotOf(harness: Harness) {
	return (await harness.snapshot(LiveDoc, 1 as never, context))?.tools?.[0];
}

/** The tool task of the first slot, once it is `status`. */
async function parkedTask(harness: Harness, status: "sleeping" | "waiting" = "sleeping"): Promise<TaskId> {
	let id: TaskId | undefined;
	await waitFor(async () => {
		id = (await slotOf(harness))?.taskId;
		return id !== undefined && (await harness.getTask(id, context))?.state.status === status;
	});
	return id!;
}

/** What one run of a parking tool saw. */
type Run = { readonly wake: WakeReason | undefined; readonly checkpoint: JsonValue | undefined };

/** A tool that reports, then parks on `Done` until the key holds a value, and answers with it. */
function signalTool(runs: Run[], extra: Partial<ToolRegistration> = {}) {
	return tool(
		"ci",
		async (_args, api, ctx) => {
			runs.push({ wake: api.wake, checkpoint: api.checkpoint });
			const state = await api.readSignal(Done, "done", ctx);
			if (state !== undefined && "value" in state) return { output: [{ type: "text", text: state.value.text }] };
			api.output("started\n");
			api.diagnostic({ severity: "info", message: `run ${runs.length}` });
			await api.details({ build: runs.length }, ctx);
			return { sleep: { checkpoint: { build: runs.length }, signals: [Done.key("done")] } };
		},
		extra,
	);
}

async function open(setup: ChatSetup, storage: Storage = new MemoryStorage(), env?: ExecutionEnv) {
	const opened = await openChat(storage, setup, env === undefined ? {} : { env });
	opened.harness.resume();
	return opened;
}

describe("parking on a signal", () => {
	it("holds no invocation, shows the slot sleeping without output, and runs again once woken", async () => {
		const setup = chatSetup();
		const runs: Run[] = [];
		addTool(setup.registry, signalTool(runs));
		setup.faux.setResponses([call("ci"), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const id = await parkedTask(harness);
		expect((await harness.getTask(id, context))?.state).toEqual({
			status: "sleeping",
			checkpoint: { phase: "parked", arguments: {}, replay: "unsafe", checkpoint: { build: 1 } },
			signals: [Done.key("done")],
		});
		// Details and diagnostics stay, the output goes.
		expect(await slotOf(harness)).toMatchObject({
			status: "sleeping",
			details: { build: 1 },
			diagnostics: [{ severity: "info", message: "run 1" }],
		});
		expect((await slotOf(harness))?.output).toBeUndefined();
		await waitFor(() => !harness.wake().active);
		expect(harness.wake()).toEqual({ active: false });

		expect(await harness.signal(id, Done, "done", { text: "passed" }, context)).toBe("delivered");
		expect((await submission.wait(context)).status).toBe("done");
		expect(runs).toEqual([
			{ wake: undefined, checkpoint: undefined },
			{ wake: { reason: "signal", signal: "test.done", key: "done" }, checkpoint: { build: 1 } },
		]);
		const [result] = results(await allEntries(root));
		// The result keeps the details and diagnostics the parked run reported.
		expect(result).toMatchObject({ isError: false, details: { build: 1 } });
		expect(text(result)).toBe("passed|<harness>\n[info] run 1\n</harness>");
		expect(result!.durationMs).toBeGreaterThanOrEqual(0);
		await harness.close(context);
	});

	it("parks on time and wakes with reason time", async () => {
		const setup = chatSetup();
		let clock = 1_000;
		setup.now = () => clock;
		const wakes: (WakeReason | undefined)[] = [];
		addTool(
			setup.registry,
			tool("poll", async (_args, api) => {
				wakes.push(api.wake);
				return api.wake === undefined ? { sleep: { until: api.now() + 500 } } : { output: [] };
			}),
		);
		setup.faux.setResponses([call("poll"), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await parkedTask(harness);
		await waitFor(() => harness.wake().at === 1_500 && !harness.wake().active);
		clock = 1_500;
		harness.resume();
		expect((await submission.wait(context)).status).toBe("done");
		expect(wakes).toEqual([undefined, { reason: "time" }]);
		const [result] = results(await allEntries(root));
		// The span from the call's first run to its result, on the Harness clock.
		expect(result!.durationMs).toBe(500);
		await harness.close(context);
	});

	it("stays parked across reopen, running no tool code, and wakes on a later delivery", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const runs: Run[] = [];
		addTool(setup.registry, signalTool(runs));
		setup.faux.setResponses([call("ci"), DONE]);
		let opened = await open(setup, await openNodeSqliteStorage(path));
		const submissionId = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		const id = await parkedTask(opened.harness);
		await opened.harness.close(context);
		opened = await open(setup, await openNodeSqliteStorage(path));
		await waitFor(() => !opened.harness.wake().active);
		expect(runs).toHaveLength(1);
		await opened.harness.signal(id, Done, "done", { text: "later" }, context);
		expect((await (await opened.harness.submission(submissionId, context))!.wait(context)).status).toBe("done");
		expect(runs).toHaveLength(2);
		await opened.harness.close(context);
	});
});

describe("parking nested calls", () => {
	it("parks a nested call, shown sleeping, while its caller awaits it, and returns its result once woken", async () => {
		const setup = chatSetup();
		// A clock that runs, as progress pacing needs, and jumps two seconds while the call is parked.
		let offset = 0;
		setup.now = () => Date.now() + offset;
		const runs: Run[] = [];
		addTool(setup.registry, signalTool(runs));
		let nested: { isError: boolean; durationMs?: number } | undefined;
		addTool(
			setup.registry,
			tool(
				"outer",
				async (_args, api, ctx) => {
					const result = await api.executeTool("ci", {}, ctx, { key: "ci" });
					nested = {
						isError: result.isError,
						...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
					};
					return { output: [{ type: "text", text: String(result.structuredOutput) }] };
				},
				{ replay: "safe" },
			),
		);
		setup.faux.setResponses([call("outer"), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		let inner: TaskId | undefined;
		await waitFor(async () => {
			const slot = (await harness.snapshot(LiveDoc, root.id, context))?.nestedTools?.[0];
			inner = slot?.taskId;
			return slot?.status === "sleeping";
		});
		offset = 2_000;
		await harness.signal(inner!, Done, "done", { text: "nested passed" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		expect(nested?.isError).toBe(false);
		expect(nested?.durationMs).toBeGreaterThanOrEqual(2_000);
		expect(text(results(await allEntries(root))[0])).toBe("nested passed");
		expect(runs).toHaveLength(2);
		await harness.close(context);
	});
});

describe("parking on tasks", () => {
	it("waits for a child it owns, with policy any, and runs again with the ended task in its wake", async () => {
		const setup = chatSetup();
		const Child = defineTask<null, { phase: "sleep" } | { phase: "done" }, string>({
			name: "test.child",
			version: 1,
			initial: () => ({ phase: "sleep" }),
			phases: {
				sleep: (_task, runtime, ctx) =>
					runtime.commit(
						() => ({ status: "sleeping", checkpoint: { phase: "done" }, signals: [Done.key("child")] }),
						ctx,
					),
				done: (_task, runtime, ctx) => runtime.commit(() => completed("child done"), ctx),
			},
			abort: (_task, runtime, ctx) => runtime.commit(() => abortedWith("test"), ctx),
		});
		addTask(setup.registry, Child);
		let child: TaskId | undefined;
		const wakes: (WakeReason | undefined)[] = [];
		addTool(
			setup.registry,
			tool(
				"spawn",
				async (_args, api, ctx) => {
					wakes.push(api.wake);
					if (api.wake !== undefined) return { output: [{ type: "text", text: "joined" }] };
					child = await api.createTask(Child, null, { ownership: { kind: "task", taskId: api.taskId } }, ctx);
					return { wait: { on: [child], policy: "any" } };
				},
				{ replay: "safe" },
			),
		);
		setup.faux.setResponses([call("spawn"), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await parkedTask(harness, "waiting");
		expect((await slotOf(harness))?.status).toBe("waiting");
		await harness.signal(child!, Done, "child", { text: "go" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		expect(wakes).toEqual([undefined, { reason: "tasks", ended: [child] }]);
		await harness.close(context);
	});
});

describe("invalid parks", () => {
	it("ends the call with an invalid_park result, through afterTool, and fails its task", async () => {
		const parks: Record<string, unknown> = {
			mixed: { sleep: { until: 1 }, wait: { on: [], policy: "any" } },
			result: { sleep: { until: 1 }, output: [] },
			empty: { sleep: {} },
			unowned: { wait: { on: [1], policy: "any" } },
		};
		for (const [name, returned] of Object.entries(parks)) {
			const setup = chatSetup();
			addTool(
				setup.registry,
				tool(name, async () => returned as never),
			);
			setup.faux.setResponses([call(name), DONE]);
			const { harness, root } = await open(setup);
			const submission = await root.submit({ type: "input", content: "go" }, context);
			expect((await submission.wait(context)).status).toBe("done");
			const [result] = results(await allEntries(root));
			expect(result!.isError).toBe(true);
			expect(text(result)).toContain(`Tool ${name} returned an invalid park`);
			const id = (await slotOf(harness))?.taskId;
			expect(id).toBeUndefined();
			await harness.close(context);
		}
	});
});

describe("invalid parks the commit refuses", () => {
	it("ends a call that sleeps again on the key that woke it with invalid_park", async () => {
		const setup = chatSetup();
		let runs = 0;
		addTool(
			setup.registry,
			tool("again", async () => {
				runs++;
				return { sleep: { signals: [Done.key("k")] } };
			}),
		);
		setup.faux.setResponses([call("again"), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const id = await parkedTask(harness);
		await harness.signal(id, Done, "k", { text: "x" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		expect(runs).toBe(2);
		expect(text(results(await allEntries(root))[0])).toContain("it already woke a wait");
		expect((await harness.getTask(id, context))?.state).toMatchObject({ outcome: { status: "failed" } });
		await harness.close(context);
	});
});

describe("cancel", () => {
	it("runs when a parked call is aborted, with the park's checkpoint and the environment, and the call ends aborted", async () => {
		const setup = chatSetup();
		const runs: Run[] = [];
		const cancels: Run[] = [];
		const envs: (string | undefined)[] = [];
		addTool(
			setup.registry,
			signalTool(runs, {
				cancel: async (_args, api) => {
					cancels.push({ wake: api.wake, checkpoint: api.checkpoint });
					envs.push(api.env?.cwd);
				},
			}),
		);
		setup.faux.setResponses([call("ci"), DONE]);
		const { harness, root } = await open(setup, new MemoryStorage(), { cwd: "/work" } as ExecutionEnv);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await parkedTask(harness);
		await root.abort(context);
		expect((await submission.wait(context)).status).toBe("unanswered");
		expect(cancels).toEqual([{ wake: undefined, checkpoint: { build: 1 } }]);
		expect(envs).toEqual(["/work"]);
		const [result] = results(await allEntries(root));
		expect(text(result)).toContain("Tool ci was aborted");
		await harness.close(context);
	});

	it("runs also under restartLimit 1, and a throw from it is reported while the call still ends aborted", async () => {
		const setup = chatSetup();
		setup.settings.restartLimit = 1;
		let cancels = 0;
		addTool(
			setup.registry,
			signalTool([], {
				cancel: async () => {
					cancels++;
					throw new Error("cancel failed");
				},
			}),
		);
		setup.faux.setResponses([call("ci"), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const id = await parkedTask(harness);
		await root.abort(context);
		await submission.wait(context);
		expect(cancels).toBe(1);
		expect((await harness.getTask(id, context))?.state).toMatchObject({ outcome: { status: "aborted" } });
		expect(setup.reports.map((error) => (error as Error).message)).toContain("cancel failed");
		await harness.close(context);
	});

	it("runs after an abort that cut off a woken run, which cleans up through its context too", async () => {
		const setup = chatSetup();
		const cancels: Run[] = [];
		const running = deferred();
		const cleaned: string[] = [];
		addTool(
			setup.registry,
			tool(
				"ci",
				async (_args, api, ctx) => {
					if (api.wake === undefined) return { sleep: { checkpoint: "first", signals: [Done.key("done")] } };
					running.resolve();
					await aborted(ctx.abortSignal!).catch((error) => {
						cleaned.push("execute");
						throw error;
					});
					return {};
				},
				{ cancel: async (_args, api) => void cancels.push({ wake: api.wake, checkpoint: api.checkpoint }) },
			),
		);
		setup.faux.setResponses([call("ci"), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const id = await parkedTask(harness);
		await harness.signal(id, Done, "done", { text: "x" }, context);
		await running.promise;
		await root.abort(context);
		await submission.wait(context);
		expect(cleaned).toEqual(["execute"]);
		expect(cancels).toEqual([{ wake: undefined, checkpoint: "first" }]);
		await harness.close(context);
	});

	it("does not run for a parked call whose tool is gone; the abort is reported", async () => {
		const setup = chatSetup();
		const cancels: Run[] = [];
		const installed = addTool(
			setup.registry,
			signalTool([], { cancel: async (_args, api) => void cancels.push({ wake: api.wake, checkpoint: null }) }),
		);
		setup.faux.setResponses([call("ci"), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await parkedTask(harness);
		installed.dispose();
		await root.abort(context);
		expect((await submission.wait(context)).status).toBe("unanswered");
		expect(cancels).toEqual([]);
		expect(setup.reports.map((error) => (error as Error).message)).toContain(
			"Tool ci is not available: its parked call c1 was not cancelled",
		);
		await harness.close(context);
	});

	it("runs in the run itself when the park's commit finds the call abort-marked", async () => {
		const setup = chatSetup();
		const release = deferred();
		const entered = deferred();
		const cancels: Run[] = [];
		addTool(
			setup.registry,
			tool(
				"race",
				async () => {
					entered.resolve();
					// The abort arrives while the tool still runs; it ignores the signal and parks anyway.
					await release.promise;
					return { sleep: { checkpoint: "started", signals: [Done.key("k")] } };
				},
				{
					cancel: async (_args, api, ctx) => {
						cancels.push({ wake: api.wake, checkpoint: api.checkpoint });
						expect(ctx.abortSignal?.aborted).toBe(false);
					},
				},
			),
		);
		setup.faux.setResponses([call("race"), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await entered.promise;
		const id = (await slotOf(harness))!.taskId!;
		const aborting = harness.abortTask(id, context);
		await waitFor(async () => (await harness.getTask(id, context))?.abortRequested === true);
		release.resolve();
		await aborting;
		await harness.waitForTask(id, context);
		// The run's cancel with the park's checkpoint; the abort handler finds `execute` without a wake and runs none.
		expect(cancels).toEqual([{ wake: undefined, checkpoint: "started" }]);
		await root.abort(context);
		await submission.wait(context);
		await harness.close(context);
	});
});

describe("waking", () => {
	it("ends a woken call whose tool is gone with tool_unavailable, failed, and reports it", async () => {
		const setup = chatSetup();
		const runs: Run[] = [];
		const installed = addTool(setup.registry, signalTool(runs));
		setup.faux.setResponses([call("ci"), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const id = await parkedTask(harness);
		installed.dispose();
		await harness.signal(id, Done, "done", { text: "late" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		const settled = await harness.waitForTask(id, context);
		expect(settled.state.outcome.status).toBe("failed");
		const [result] = results(await allEntries(root));
		// Built from the slot: the details and diagnostics the parked run left stay.
		expect(result).toMatchObject({ isError: true, details: { build: 1 } });
		expect(text(result)).toContain("[info] run 1");
		expect(text(result)).toContain("Tool ci is not available");
		expect(setup.reports.map((error) => (error as Error).message)).toContain(
			"Tool ci is not available: its parked call c1 cannot run again",
		);
		expect(runs).toHaveLength(1);
		await harness.close(context);
	});

	it("settles a woken unsafe run cut off by a crash interrupted, after cancel", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const cancels: Run[] = [];
		const started = deferred();
		let runs = 0;
		addTool(
			setup.registry,
			tool(
				"ci",
				async (_args, api, ctx) => {
					runs++;
					if (api.wake === undefined) return { sleep: { checkpoint: "first", signals: [Done.key("done")] } };
					api.output("rerun\n");
					await api.details({ woken: true }, ctx);
					started.resolve();
					await aborted(ctx.abortSignal!);
					return {};
				},
				{ cancel: async (_args, api) => void cancels.push({ wake: api.wake, checkpoint: api.checkpoint }) },
			),
		);
		setup.faux.setResponses([call("ci"), DONE]);
		const crashed = await open(setup, await openNodeSqliteStorage(path));
		const submissionId = (await crashed.root.submit({ type: "input", content: "go" }, context)).id;
		const id = await parkedTask(crashed.harness);
		await crashed.harness.signal(id, Done, "done", { text: "x" }, context);
		await started.promise;
		// The process dies here: another one opens the same database.
		const next = await open(setup, await openNodeSqliteStorage(path));
		expect((await (await next.harness.submission(submissionId, context))!.wait(context)).status).toBe("done");
		expect(runs).toBe(2);
		expect(cancels).toEqual([{ wake: undefined, checkpoint: "first" }]);
		const [result] = results(await allEntries(next.root));
		expect(text(result)).toContain("Tool ci was interrupted and may have partially run");
		await next.harness.close(context);
		await crashed.harness.close(context);
	});

	it("reruns a woken safe run cut off by a crash, keeping the slot's details and diagnostics, not its output", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const started = deferred();
		const seen: Run[] = [];
		addTool(
			setup.registry,
			tool(
				"ci",
				async (_args, api, ctx) => {
					seen.push({ wake: api.wake, checkpoint: api.checkpoint });
					if (api.wake === undefined) {
						api.diagnostic({ severity: "info", message: "parked" });
						await api.details({ build: 1 }, ctx);
						return { sleep: { checkpoint: "first", signals: [Done.key("done")] } };
					}
					if (seen.length === 2) {
						api.output("cut off\n");
						started.resolve();
						await aborted(ctx.abortSignal!);
					}
					return {};
				},
				{ replay: "safe" },
			),
		);
		setup.faux.setResponses([call("ci"), DONE]);
		const crashed = await open(setup, await openNodeSqliteStorage(path));
		const submissionId = (await crashed.root.submit({ type: "input", content: "go" }, context)).id;
		const id = await parkedTask(crashed.harness);
		await crashed.harness.signal(id, Done, "done", { text: "x" }, context);
		await started.promise;
		const next = await open(setup, await openNodeSqliteStorage(path));
		expect((await (await next.harness.submission(submissionId, context))!.wait(context)).status).toBe("done");
		const wake = { reason: "signal", signal: "test.done", key: "done" };
		expect(seen).toEqual([
			{ wake: undefined, checkpoint: undefined },
			{ wake, checkpoint: "first" },
			{ wake, checkpoint: "first" },
		]);
		// The park stored the details and diagnostics; the rerun starts from them, without the cut-off run's output.
		const [result] = results(await allEntries(next.root));
		expect(result).toMatchObject({ isError: false, details: { build: 1 } });
		expect(text(result)).toBe("<harness>\n[info] parked\n</harness>");
		await next.harness.close(context);
		await crashed.harness.close(context);
	});
});

describe("wrappers", () => {
	it("pass a base's park through, and a park of their own is invalid", async () => {
		for (const own of [false, true]) {
			const setup = chatSetup();
			const runs: Run[] = [];
			const base = signalTool(runs);
			addTool(setup.registry, base);
			setup.registry.install(
				defineExtension({
					name: "wrapper",
					wraps: [
						wrapTool(base, (inner) => ({
							...inner,
							execute: async (args, api, ctx) => {
								const returned = await inner.execute(args, api, ctx);
								return own && "sleep" in returned ? { sleep: { ...returned.sleep } } : returned;
							},
						})),
					],
				}),
			);
			setup.faux.setResponses([call("ci"), DONE]);
			const { harness, root } = await open(setup);
			const submission = await root.submit({ type: "input", content: "go" }, context);
			if (own) {
				expect((await submission.wait(context)).status).toBe("done");
				expect(text(results(await allEntries(root))[0])).toContain(
					"a wrapper returned a park its base did not return",
				);
			} else {
				const id = await parkedTask(harness);
				await harness.signal(id, Done, "done", { text: "wrapped" }, context);
				expect((await submission.wait(context)).status).toBe("done");
				expect(runs).toHaveLength(2);
			}
			await harness.close(context);
		}
	});
	it("accept one park object its base returns to calls running at once", async () => {
		const setup = chatSetup();
		const shared = { sleep: { signals: [Done.key("done")] } } as const;
		const base = tool("ci", async (_args, api, ctx) =>
			(await api.readSignal(Done, "done", ctx)) === undefined ? shared : { output: [{ type: "text", text: "ok" }] },
		);
		addTool(setup.registry, base);
		setup.registry.install(defineExtension({ name: "wrapper", wraps: [wrapTool(base, (inner) => ({ ...inner }))] }));
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("ci", {}, { id: "a" }), fauxToolCall("ci", {}, { id: "b" })], {
				stopReason: "toolUse",
			}),
			DONE,
		]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		let ids: TaskId[] = [];
		await waitFor(async () => {
			const slots = (await harness.snapshot(LiveDoc, root.id, context))?.tools ?? [];
			ids = slots.flatMap((slot) => (slot.status === "sleeping" ? [slot.taskId!] : []));
			return ids.length === 2;
		});
		for (const id of ids) await harness.signal(id, Done, "done", { text: "x" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		expect(results(await allEntries(root)).map((result) => result.isError)).toEqual([false, false]);
		await harness.close(context);
	});

	it("refuse a park the wrapper kept from an earlier run instead of asking its base", async () => {
		const setup = chatSetup();
		const base = signalTool([]);
		addTool(setup.registry, base);
		let kept: ToolPark | undefined;
		setup.registry.install(
			defineExtension({
				name: "wrapper",
				wraps: [
					wrapTool(base, (inner) => ({
						...inner,
						execute: async (args, api, ctx) => {
							if (kept !== undefined) return kept;
							const returned = await inner.execute(args, api, ctx);
							if ("sleep" in returned && returned.sleep !== undefined) kept = returned;
							return returned;
						},
					})),
				],
			}),
		);
		setup.faux.setResponses([call("ci"), DONE]);
		const { harness, root } = await open(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const id = await parkedTask(harness);
		await harness.signal(id, Done, "done", { text: "x" }, context);
		expect((await submission.wait(context)).status).toBe("done");
		expect(text(results(await allEntries(root))[0])).toContain("a wrapper returned a park its base did not return");
		await harness.close(context);
	});
});
