import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type ToolResultMessage,
	Type,
} from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTask,
	defineTool,
	type Harness,
	LiveDoc,
	type NestedToolExecutionResult,
	type TaskId,
	type ToolRegistration,
	ToolResultEntry,
	ToolTask,
	type ToolTaskInput,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat } from "./chat-support.ts";
import { addHooks, addTool } from "./harness-support.ts";
import { nestedResultOf, nestedResults, viewHistory } from "./live-support.ts";
import { context } from "./session-support.ts";
import { aborted, deferred, eventually } from "./task-support.ts";

const Parameters = Type.Object({ text: Type.Optional(Type.String()) });

function tool(
	name: string,
	execute: ToolRegistration<typeof Parameters>["execute"],
	extra: Partial<ToolRegistration<typeof Parameters>> = {},
): ToolRegistration<typeof Parameters> {
	return defineTool({ name, description: name, parameters: Parameters, execute, ...extra });
}

function call(name: string, id = "c1"): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, {}, { id })], { stopReason: "toolUse" });
}

const DONE = fauxAssistantMessage([fauxText("done")]);

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-nested-restart-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

/** Open the SQLite Harness without starting scheduling. */
function open(path: string, setup: ChatSetup) {
	return openNodeSqliteStorage(path).then((storage) => openChat(storage, setup));
}

async function nestedTasks(harness: Harness) {
	const tasks = (await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)).items;
	return tasks.filter((task) => (task.input as ToolTaskInput).kind === "nested");
}

function results(entries: Awaited<ReturnType<typeof allEntries>>): ToolResultMessage[] {
	return entries.filter((entry) => ToolResultEntry.is(entry)).map((entry) => entry.model![0] as ToolResultMessage);
}

function codes(result: NestedToolExecutionResult | undefined): string[] {
	return (result?.diagnostics ?? []).flatMap((diagnostic) => (diagnostic.code === undefined ? [] : [diagnostic.code]));
}

describe("nested tool calls across a restart", () => {
	it("abandons a replay-unsafe caller's unfinished nested calls before they run again", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const runs = { started: 0, gated: 0 };
		const running = deferred();
		const gated = deferred();
		// Replay-safe, so only the abandonment keeps it from rerunning.
		addTool(
			setup.registry,
			tool(
				"started",
				async (_args, api, callContext) => {
					runs.started++;
					api.output("partial\n");
					await api.details({ step: 1 }, callContext);
					running.resolve();
					return aborted(callContext.abortSignal!);
				},
				{ replay: "safe" },
			),
		);
		addTool(
			setup.registry,
			tool("gated", async () => {
				runs.gated++;
				return {};
			}),
		);
		// Holds `gated` in its `call` phase, before intent, until the Harness closes.
		addHooks(setup.registry, ToolTask, {
			beforeTool: async (hookCall, _api, hookContext: Context) => {
				if (hookCall.name !== "gated") return undefined;
				gated.resolve();
				return aborted(hookContext.abortSignal!);
			},
		});
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				const first = api.executeTool("started", {}, callContext);
				const second = api.executeTool("gated", {}, callContext);
				await Promise.all([first, second]);
				return {};
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await Promise.all([running.promise, gated.promise]);
		await opened.harness.close(context);

		opened = await open(path, setup);
		const history = await viewHistory(opened.harness, opened.root.id);
		const nested = nestedResults(opened.harness);
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		await opened.harness.waitForIdle(context);
		history.detach();
		expect(runs).toEqual({ started: 1, gated: 0 });
		const [started, gate] = await nestedTasks(opened.harness);
		for (const task of [started, gate]) {
			expect(task).toMatchObject({ abandonOnRestart: true, abortRequested: true, abortReason: "restart" });
			expect(task!.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
		}
		const end = (callId: string) => nestedResultOf(history.live(), nested, callId);
		expect(codes(end("c1/1"))).toEqual(["interrupted"]);
		expect(end("c1/1")).toMatchObject({ isError: true, details: { step: 1 } });
		expect(end("c1/1")).not.toHaveProperty("structuredOutput");
		expect(codes(end("c1/2"))).toEqual(["abandoned"]);
		// The caller reports the interruption.
		const [result] = results(await allEntries(opened.root));
		expect(result).toMatchObject({ toolCallId: "c1", isError: true });
		expect(await opened.harness.snapshot(LiveDoc, opened.root.id, context)).toEqual({});
		await opened.harness.close(context);
	});

	it("abandons the work an abandoned nested call owns, which never runs a phase again", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const phases: string[] = [];
		const aborts: (string | undefined)[] = [];
		const started = deferred();
		const Worker = defineTask<null, { phase: "work" }, null>({
			name: "test.worker",
			version: 1,
			initial: () => ({ phase: "work" }),
			phases: {
				work: async (_task, runtime) => {
					phases.push("work");
					started.resolve();
					await aborted(runtime.signal);
				},
			},
			abort: async (task, runtime, abortContext) => {
				aborts.push(task.abortReason);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
			},
		});
		setup.registry.install(defineExtension({ name: "worker", tasks: [Worker] }));
		let worker: TaskId | undefined;
		addTool(
			setup.registry,
			tool("spawn", async (_args, api, callContext) => {
				worker = await api.createTask(
					Worker,
					null,
					{ ownership: { kind: "task", taskId: api.taskId } },
					callContext,
				);
				await api.waitForTask(worker, callContext);
				return {};
			}),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				await api.executeTool("spawn", {}, callContext);
				return {};
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await started.promise;
		await opened.harness.close(context);

		opened = await open(path, setup);
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		await opened.harness.waitForIdle(context);
		expect(phases).toEqual(["work"]);
		// The cascade passed the restart reason on.
		expect(aborts).toEqual(["restart"]);
		expect((await opened.harness.getTask(worker!, context))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "aborted" },
		});
		await opened.harness.close(context);
	});

	it("keeps an abandoned task whose definition is missing waiting until it is installed, then runs its abort", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const aborts: (string | undefined)[] = [];
		const started = deferred();
		const Worker = defineTask<null, { phase: "work" }, null>({
			name: "test.late",
			version: 1,
			initial: () => ({ phase: "work" }),
			phases: {
				work: async (_task, runtime) => {
					started.resolve();
					await aborted(runtime.signal);
				},
			},
			abort: async (task, runtime, abortContext) => {
				aborts.push(task.abortReason);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
			},
		});
		const extension = defineExtension({ name: "late", tasks: [Worker] });
		setup.registry.install(extension);
		let worker: TaskId | undefined;
		addTool(
			setup.registry,
			tool("spawn", async (_args, api, callContext) => {
				worker = await api.createTask(
					Worker,
					null,
					{ ownership: { kind: "task", taskId: api.taskId } },
					callContext,
				);
				await api.waitForTask(worker, callContext);
				return {};
			}),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				await api.executeTool("spawn", {}, callContext);
				return {};
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await started.promise;
		await opened.harness.close(context);

		setup.registry.uninstall(extension);
		opened = await open(path, setup);
		opened.harness.resume();
		await eventually(async () => {
			const inspected = (await opened.harness.inspect(context)).tasks.find((task) => task.record.id === worker);
			return inspected?.state.kind === "blocked";
		});
		expect((await opened.harness.getTask(worker!, context))?.state.status).not.toBe("terminal");
		expect(aborts).toEqual([]);
		setup.registry.install(extension);
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect(aborts).toEqual(["restart"]);
		expect((await opened.harness.getTask(worker!, context))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "aborted" },
		});
		await opened.harness.close(context);
	});

	it("orphans an abandoned task whose definition is missing once an abort is requested", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const started = deferred();
		const Worker = defineTask<null, { phase: "work" }, null>({
			name: "test.gone",
			version: 1,
			initial: () => ({ phase: "work" }),
			phases: {
				work: async (_task, runtime) => {
					started.resolve();
					await aborted(runtime.signal);
				},
			},
			abort: async (_task, runtime, abortContext) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
			},
		});
		const extension = defineExtension({ name: "gone", tasks: [Worker] });
		setup.registry.install(extension);
		let worker: TaskId | undefined;
		addTool(
			setup.registry,
			tool("spawn", async (_args, api, callContext) => {
				worker = await api.createTask(
					Worker,
					null,
					{ ownership: { kind: "task", taskId: api.taskId } },
					callContext,
				);
				await api.waitForTask(worker, callContext);
				return {};
			}),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				await api.executeTool("spawn", {}, callContext);
				return {};
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await started.promise;
		await opened.harness.close(context);

		setup.registry.uninstall(extension);
		opened = await open(path, setup);
		opened.harness.resume();
		await eventually(async () => {
			const record = await opened.harness.getTask(worker!, context);
			return record?.abortReason === "restart";
		});
		await opened.root.abort(context);
		expect((await opened.harness.getTask(worker!, context))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "orphaned", reason: "missing_task" },
		});
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("unanswered");
		await opened.harness.close(context);
	});

	it("marks nothing when the reopened Harness never starts scheduling", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const running = deferred();
		addTool(
			setup.registry,
			tool("hang", async (_args, _api, callContext) => {
				running.resolve();
				return aborted(callContext.abortSignal!);
			}),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				await api.executeTool("hang", {}, callContext);
				return {};
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		let opened = await open(path, setup);
		await opened.root.submit({ type: "input", content: "go" }, context);
		await running.promise;
		await opened.harness.close(context);

		// An inspection-only open: no resume, no submission.
		opened = await open(path, setup);
		const inspected = await opened.harness.inspect(context);
		expect(inspected.scheduling).toBe("paused");
		await opened.harness.close(context);

		opened = await open(path, setup);
		const [nested] = await nestedTasks(opened.harness);
		expect(nested).toMatchObject({ abandonOnRestart: true, abortRequested: false });
		expect(nested!.state.status).toBe("pending");
		await opened.harness.close(context);
	});

	it("lets a replay-safe caller's unfinished nested calls recover and reattaches to them by key", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const runs = { safe: 0, unsafe: 0, caller: 0 };
		const running = { safe: deferred(), unsafe: deferred() };
		addTool(
			setup.registry,
			tool(
				"safe",
				async (_args, _api, callContext) => {
					runs.safe++;
					if (runs.safe === 1) {
						running.safe.resolve();
						await aborted(callContext.abortSignal!);
					}
					return { output: [{ type: "text", text: `safe run ${runs.safe}` }] };
				},
				{ replay: "safe" },
			),
		);
		addTool(
			setup.registry,
			tool("unsafe", async (_args, _api, callContext) => {
				runs.unsafe++;
				running.unsafe.resolve();
				return aborted(callContext.abortSignal!);
			}),
		);
		let results_: NestedToolExecutionResult[] = [];
		addTool(
			setup.registry,
			tool(
				"batch",
				async (_args, api, callContext) => {
					runs.caller++;
					results_ = await Promise.all([
						api.executeTool("safe", {}, callContext),
						api.executeTool("unsafe", {}, callContext),
					]);
					return {};
				},
				{ replay: "safe" },
			),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await Promise.all([running.safe.promise, running.unsafe.promise]);
		await opened.harness.close(context);

		opened = await open(path, setup);
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect(runs).toEqual({ safe: 2, unsafe: 1, caller: 2 });
		// Default keys follow call order, so the rerun found both calls.
		expect(await nestedTasks(opened.harness)).toHaveLength(2);
		for (const task of await nestedTasks(opened.harness)) {
			expect(task.abandonOnRestart).toBeUndefined();
			expect(task.abortReason).toBeUndefined();
		}
		expect(results_[0]?.structuredOutput).toBe("safe run 2");
		expect(codes(results_[1])).toEqual(["interrupted"]);
		await opened.harness.close(context);
	});

	it("clears the slots of nested calls an earlier attempt finished when the rerun makes none", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const finished = deferred();
		let attempts = 0;
		addTool(
			setup.registry,
			tool("quick", async () => ({ output: [{ type: "text", text: "ok" }] })),
		);
		addTool(
			setup.registry,
			tool(
				"caller",
				async (_args, api, callContext) => {
					attempts++;
					if (attempts === 1) {
						await api.executeTool("quick", {}, callContext);
						finished.resolve();
						return aborted(callContext.abortSignal!);
					}
					return { output: [{ type: "text", text: "done" }] };
				},
				{ replay: "safe" },
			),
		);
		setup.faux.setResponses([call("caller"), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await finished.promise;
		// The finished nested call's slot is still listed, below its running caller.
		expect((await opened.harness.snapshot(LiveDoc, opened.root.id, context))?.nestedTools).toHaveLength(1);
		await opened.harness.close(context);

		opened = await open(path, setup);
		let slotsAfterCaller: number | undefined;
		opened.harness.observeCommits({
			advance: (publication) => {
				for (const change of publication.changes) {
					if (change.type !== "task" || change.value.kind !== ToolTask.definition.name) continue;
					if ((change.value.input as ToolTaskInput).kind !== "model" || change.value.state.status !== "terminal")
						continue;
					const live = publication.changes.find(
						(each) => each.type === "document" && each.record.kind === "pi.live",
					);
					const value =
						live?.type === "document" && live.kind === "change"
							? (live.value as { nestedTools?: unknown[] })
							: undefined;
					slotsAfterCaller = value?.nestedTools?.length ?? 0;
				}
			},
			end: () => {},
		});
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect(attempts).toBe(2);
		// The caller's terminal commit removed the slot, though the rerun made no nested call.
		expect(slotsAfterCaller).toBe(0);
		await opened.harness.close(context);
	});

	it("aborts a nested call an earlier attempt of a replay-safe caller left running and the rerun never made again", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const running = deferred();
		let attempts = 0;
		addTool(
			setup.registry,
			tool(
				"slow",
				async (_args, _api, callContext) => {
					running.resolve();
					return aborted(callContext.abortSignal!);
				},
				{ replay: "safe" },
			),
		);
		addTool(
			setup.registry,
			tool(
				"caller",
				async (_args, api, callContext) => {
					attempts++;
					// Only the first attempt calls `slow`; the rerun after the restart returns at once.
					if (attempts === 1) await api.executeTool("slow", {}, callContext, { key: "slow" });
					return { output: [{ type: "text", text: "done" }] };
				},
				{ replay: "safe" },
			),
		);
		setup.faux.setResponses([call("caller"), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await running.promise;
		await opened.harness.close(context);

		opened = await open(path, setup);
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect(attempts).toBe(2);
		// The rerun's settlement found the leftover call among the tasks it owns and aborted it.
		const [leftover] = await nestedTasks(opened.harness);
		expect(leftover?.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
		await opened.harness.close(context);
	});

	it("reattaches a replay-safe caller by default and explicit keys, and rejects a rerun that calls differently", async () => {
		for (const order of ["same", "swapped"] as const) {
			const path = await sqlitePath();
			const setup = chatSetup();
			const runs: string[] = [];
			addTool(
				setup.registry,
				tool("echo", async (args) => {
					runs.push(args.text ?? "");
					return { output: [{ type: "text", text: `echo ${args.text}` }] };
				}),
			);
			const blocked = deferred();
			let callerRuns = 0;
			let seen: string[] = [];
			addTool(
				setup.registry,
				tool(
					"batch",
					async (_args, api, callContext) => {
						callerRuns++;
						const first = callerRuns === 2 && order === "swapped" ? "b" : "a";
						const one = await api.executeTool("echo", { text: first }, callContext);
						const named = await api.executeTool("echo", { text: "named" }, callContext, { key: "named" });
						if (callerRuns === 1) {
							blocked.resolve();
							await aborted(callContext.abortSignal!);
						}
						seen = [one, named].map((result) => result.structuredOutput as string);
						return {};
					},
					{ replay: "safe" },
				),
			);
			setup.faux.setResponses([call("batch"), DONE]);
			let opened = await open(path, setup);
			const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
			await blocked.promise;
			await opened.harness.close(context);

			opened = await open(path, setup);
			opened.harness.resume();
			expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
			const [result] = results(await allEntries(opened.root));
			if (order === "same") {
				expect(runs).toEqual(["a", "named"]);
				expect(seen).toEqual(["echo a", "echo named"]);
				expect(result!.isError).toBe(false);
			} else {
				// Key 1 was made with other arguments: the rerun throws instead of reusing a different call's result.
				expect(runs).toEqual(["a", "named"]);
				expect(result!.isError).toBe(true);
				expect(JSON.stringify(result!.content)).toContain("Nested call c1/1 was already made with another tool");
			}
			await opened.harness.close(context);
		}
	});

	it("abandons the child tasks a replay-unsafe tool created and awaited in memory", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const phases: string[] = [];
		const started = deferred();
		const Worker = defineTask<null, { phase: "work" }, null>({
			name: "test.direct-worker",
			version: 1,
			initial: () => ({ phase: "work" }),
			phases: {
				work: async (_task, runtime) => {
					phases.push("work");
					started.resolve();
					await aborted(runtime.signal);
				},
			},
			abort: async (task, runtime, abortContext) => {
				phases.push(`abort ${task.abortReason}`);
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
			},
		});
		setup.registry.install(defineExtension({ name: "direct-worker", tasks: [Worker] }));
		addTool(
			setup.registry,
			tool("work", async (_args, api, callContext) => {
				const id = await api.createTask(
					Worker,
					null,
					{ ownership: { kind: "task", taskId: api.taskId } },
					callContext,
				);
				await api.waitForTask(id, callContext);
				return {};
			}),
		);
		setup.faux.setResponses([call("work"), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await started.promise;
		await opened.harness.close(context);

		opened = await open(path, setup);
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect(phases).toEqual(["work", "abort restart"]);
		await opened.harness.close(context);
	});

	it("leaves background work under an abandoned nested call running, and settles without it", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const started = deferred();
		const Background = defineTask<null, { phase: "work" }, null>({
			name: "test.background",
			version: 1,
			initial: () => ({ phase: "work" }),
			phases: {
				work: async (_task, runtime) => {
					started.resolve();
					await aborted(runtime.signal);
				},
			},
			abort: async (_task, runtime, abortContext) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
			},
		});
		setup.registry.install(defineExtension({ name: "background", tasks: [Background] }));
		let background: TaskId | undefined;
		addTool(
			setup.registry,
			tool("spawn", async (_args, api, callContext) => {
				// A conversation the call owns, with background work in it, as a persistent subagent has.
				background = await api.commit(async (tx) => {
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					return tx.createTask(Background, null, {
						conversationId: child.id,
						ownership: { kind: "conversation" },
						background: true,
					});
				}, callContext);
				return aborted(callContext.abortSignal!);
			}),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				await api.executeTool("spawn", {}, callContext);
				return {};
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await started.promise;
		await opened.harness.close(context);

		opened = await open(path, setup);
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		const [spawn] = await nestedTasks(opened.harness);
		expect(spawn).toMatchObject({ abortReason: "restart", state: { status: "terminal" } });
		expect(await opened.harness.getTask(background!, context)).toMatchObject({
			abortRequested: false,
			state: { status: "running" },
		});
		await opened.harness.abortTask(background!, context);
		await opened.harness.close(context);
	});
});
