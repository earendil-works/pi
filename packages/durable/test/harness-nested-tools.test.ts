import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type ToolResultMessage,
	Type,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationView,
	defineTool,
	type EntryRecord,
	type Harness,
	LiveDoc,
	type LiveState,
	MemoryStorage,
	NestedCallDoc,
	type NestedToolExecutionResult,
	type TaskId,
	type ToolHookCall,
	type ToolRegistration,
	ToolResultEntry,
	ToolTask,
	type ToolTaskInput,
	type ToolTaskResult,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat } from "./chat-support.ts";
import { addHooks, addTool } from "./harness-support.ts";
import { endedAt, nestedResultOf, nestedResults, slotsOf, startOrder, viewHistory } from "./live-support.ts";
import { context, onValue } from "./session-support.ts";
import { aborted, deferred, eventually } from "./task-support.ts";

const Parameters = Type.Object({ text: Type.Optional(Type.String()) });
type Tool = ToolRegistration<typeof Parameters>;

function tool(name: string, execute: Tool["execute"], extra: Partial<Tool> = {}): Tool {
	return defineTool({ name, description: name, parameters: Parameters, execute, ...extra });
}

/** Returns `echo <text>` and counts its runs. */
function echoTool(extra: Partial<Tool> = {}) {
	const state = { runs: 0 };
	const registration = tool(
		"echo",
		async (args) => {
			state.runs++;
			return { output: [{ type: "text", text: `echo ${args.text ?? ""}` }] };
		},
		extra,
	);
	return { registration, state };
}

function call(name: string, args: Record<string, string> = {}, id = "c1"): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
}

const DONE = fauxAssistantMessage([fauxText("done")]);

function results(entries: readonly EntryRecord[]): ToolResultMessage[] {
	return entries.filter((entry) => ToolResultEntry.is(entry)).map((entry) => entry.model![0] as ToolResultMessage);
}

/** The text of a result message, or the value a schema-less nested call gives programs. */
function text(result: NestedToolExecutionResult | ToolResultMessage | undefined): string {
	if (result === undefined) return "";
	if (!("role" in result)) return typeof result.structuredOutput === "string" ? result.structuredOutput : "";
	return result.content.map((item) => (item.type === "text" ? item.text : "")).join("|");
}

async function toolTasks(harness: Harness) {
	return (await harness.commit((tx) => tx.scanTasks({ kind: ToolTask.definition.name }, 100), context)).items;
}

async function runOnce(setup: ChatSetup, responses: AssistantMessage[]) {
	setup.faux.setResponses(responses);
	const { harness, root } = await openChat(new MemoryStorage(), setup);
	const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
	return { harness, root, status: settled.status, entries: await allEntries(root) };
}

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

describe("nested tool calls", () => {
	it("stores one document per nested call, keyed by its key, written only by that call", async () => {
		const setup = chatSetup();
		const echo = echoTool();
		addTool(setup.registry, echo.registration);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				await Promise.all([
					api.executeTool("echo", { text: "a" }, callContext),
					api.executeTool("echo", { text: "b" }, callContext, { key: "named" }),
				]);
				return {};
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		const storage = new MemoryStorage();
		// Per document written, the keys of the nested calls it holds.
		const written: { kind: string; key: string | undefined }[] = [];
		const commit = storage.commit.bind(storage);
		storage.commit = (writes, adopt, commitContext) => {
			for (const write of writes) {
				if (write.type === "document.create") written.push({ kind: write.record.kind, key: write.record.key });
			}
			return commit(writes, adopt, commitContext);
		};
		const { harness, root } = await openChat(storage, setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const nested = written.filter((write) => write.kind.startsWith("pi.tool."));
		expect(nested).toEqual([
			{ kind: NestedCallDoc.definition.kind, key: "1" },
			{ kind: NestedCallDoc.definition.kind, key: "named" },
		]);
		await harness.close(context);
	});

	it("rejects a nested call of an aborted caller and leaves no document for it", async () => {
		const setup = chatSetup();
		const echo = echoTool();
		addTool(setup.registry, echo.registration);
		const started = deferred();
		const marked = deferred();
		let rejected: unknown;
		let caller: TaskId | undefined;
		addTool(
			setup.registry,
			tool("late", async (_args, api) => {
				caller = api.taskId;
				started.resolve();
				await marked.promise;
				// Its context is aborted too, so pass one that is not: the admission itself must refuse.
				try {
					await api.executeTool("echo", { text: "a" }, context);
				} catch (error) {
					rejected = error;
				}
				return {};
			}),
		);
		setup.faux.setResponses([call("late"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await started.promise;
		await harness.commit(async (tx) => {
			const record = (await tx.task(caller!))!;
			(tx as unknown as { setTask(value: unknown): void }).setTask({ ...record, abortRequested: true });
		}, context);
		marked.resolve();
		await submission.wait(context);
		expect(String(rejected)).toMatch(/abort mark|aborted|has settled/);
		expect(await harness.snapshot(NestedCallDoc, caller!, "1", context)).toBeUndefined();
		await harness.close(context);
	});

	it("runs a nested call as its own tool task and returns its result to the caller, not the transcript", async () => {
		const setup = chatSetup();
		const echo = echoTool();
		addTool(setup.registry, echo.registration);
		let nested: NestedToolExecutionResult | undefined;
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				nested = await api.executeTool("echo", { text: "a" }, callContext);
				return { output: [{ type: "text", text: `got ${text(nested)}` }] };
			}),
		);
		const { harness, root, status, entries } = await runOnce(setup, [call("batch"), DONE]);
		expect(status).toBe("done");
		const [parent, child] = await toolTasks(harness);
		expect(nested).toEqual({
			taskId: child!.id,
			structuredOutput: "echo a",
			isError: false,
			diagnostics: [],
			durationMs: expect.any(Number),
		});
		// One result entry: the model-issued call's, which records nothing of its nested calls.
		expect(results(entries).map((result) => [result.toolCallId, text(result)])).toEqual([["c1", "got echo a"]]);
		expect(results(entries)[0]).not.toHaveProperty("nestedCalls");
		expect(parent!.input).toMatchObject({ kind: "model", callId: "c1" });
		expect(child!.owner).toBe(parent!.id);
		expect(child!.input as ToolTaskInput).toEqual({
			kind: "nested",
			parent: parent!.id,
			parentCallId: "c1",
			key: "1",
			call: { type: "toolCall", id: "c1/1", name: "echo", arguments: { text: "a" } },
		});
		// The receipt stays small: the result lived in the caller's documents, which retired with it.
		expect(child!.state).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: { kind: "nested" } },
		});
		expect(await harness.snapshot(NestedCallDoc, parent!.id, "1", context)).toBeUndefined();
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		await harness.close(context);
	});

	it("gives each nested call its own task and call ID", async () => {
		const setup = chatSetup();
		const seen: { taskId: TaskId; callId: string }[] = [];
		addTool(
			setup.registry,
			tool("who", async (_args, api) => {
				seen.push({ taskId: api.taskId, callId: api.callId });
				return {};
			}),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				await Promise.all([
					api.executeTool("who", {}, callContext, { key: "a" }),
					api.executeTool("who", {}, callContext, { key: "b" }),
				]);
				return {};
			}),
		);
		const { harness } = await runOnce(setup, [call("batch"), DONE]);
		expect(seen.map((each) => each.callId).sort()).toEqual(["c1/a", "c1/b"]);
		expect(new Set(seen.map((each) => each.taskId)).size).toBe(2);
		await harness.close(context);
	});

	it("runs the tool hooks on nested calls, which see their parent", async () => {
		const setup = chatSetup();
		const echo = echoTool();
		addTool(setup.registry, echo.registration);
		const parents: ToolHookCall["parent"][] = [];
		addHooks(setup.registry, ToolTask, {
			beforeTool: (hookCall) => {
				parents.push(hookCall.parent);
				return hookCall.parent !== undefined && hookCall.arguments.text === "secret"
					? { block: "no secrets" }
					: undefined;
			},
			afterTool: (hookCall, result) =>
				hookCall.parent === undefined ? undefined : { ...result, output: [{ type: "text", text: "rewritten" }] },
		});
		const nested: NestedToolExecutionResult[] = [];
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				nested.push(await api.executeTool("echo", { text: "secret" }, callContext));
				nested.push(await api.executeTool("echo", { text: "public" }, callContext));
				return {};
			}),
		);
		const { harness } = await runOnce(setup, [call("batch"), DONE]);
		const [parent] = await toolTasks(harness);
		expect(parents).toEqual([undefined, { taskId: parent!.id, callId: "c1" }, { taskId: parent!.id, callId: "c1" }]);
		expect(nested[0]).toMatchObject({
			isError: true,
			diagnostics: [{ severity: "error", code: "blocked", message: "Tool call blocked: no secrets" }],
		});
		expect(text(nested[1])).toBe("rewritten");
		expect(echo.state.runs).toBe(1);
		await harness.close(context);
	});

	it("returns an error result for an unavailable tool and invalid arguments", async () => {
		const setup = chatSetup();
		addTool(setup.registry, echoTool().registration);
		const nested: NestedToolExecutionResult[] = [];
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				nested.push(await api.executeTool("missing", {}, callContext));
				nested.push(await api.executeTool("echo", { text: { not: "a string" } }, callContext));
				return {};
			}),
		);
		const { harness } = await runOnce(setup, [call("batch"), DONE]);
		expect(nested.map((result) => [result.isError, result.diagnostics[0]?.code])).toEqual([
			[true, "tool_unavailable"],
			[true, "invalid_arguments"],
		]);
		await harness.close(context);
	});

	it("returns the call a key already names, and rejects reusing the key for another call", async () => {
		const setup = chatSetup();
		const echo = echoTool();
		addTool(setup.registry, echo.registration);
		let reused: NestedToolExecutionResult | undefined;
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				await api.executeTool("echo", { text: "a" }, callContext, { key: "k" });
				reused = await api.executeTool("echo", { text: "a" }, callContext, { key: "k" });
				await api.executeTool("echo", { text: "b" }, callContext, { key: "k" });
				return {};
			}),
		);
		const { harness, entries } = await runOnce(setup, [call("batch"), DONE]);
		expect(echo.state.runs).toBe(1);
		expect(text(reused)).toBe("echo a");
		expect(text(results(entries)[0])).toContain(
			"Nested call c1/k was already made with another tool or other arguments",
		);
		await harness.close(context);
	});

	it("matches a reused key's arguments regardless of key order", async () => {
		const setup = chatSetup();
		let runs = 0;
		addTool(
			setup.registry,
			defineTool({
				name: "pair",
				description: "pair",
				parameters: Type.Object({ a: Type.String(), b: Type.String() }),
				execute: async (args) => {
					runs++;
					return { output: [{ type: "text", text: `${args.a}${args.b}` }] };
				},
			}),
		);
		const nested: NestedToolExecutionResult[] = [];
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				nested.push(await api.executeTool("pair", { a: "x", b: "y" }, callContext, { key: "k" }));
				nested.push(await api.executeTool("pair", { b: "y", a: "x" }, callContext, { key: "k" }));
				return {};
			}),
		);
		const { harness } = await runOnce(setup, [call("batch"), DONE]);
		expect(runs).toBe(1);
		expect(nested.map((result) => text(result))).toEqual(["xy", "xy"]);
		await harness.close(context);
	});

	it("aborts the nested calls a caller left running when it returns, keeping their details", async () => {
		const setup = chatSetup();
		const running = deferred();
		addTool(
			setup.registry,
			tool("hang", async (_args, api, callContext) => {
				api.output("partial\n");
				await api.details({ step: 1 }, callContext);
				running.resolve();
				return aborted(callContext.abortSignal!);
			}),
		);
		let abandoned: Promise<NestedToolExecutionResult> | undefined;
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				abandoned = api.executeTool("hang", {}, callContext);
				abandoned.catch(() => {});
				await running.promise;
				return { output: [{ type: "text", text: "returned early" }] };
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const history = await viewHistory(harness, root.id);
		const nested = nestedResults(harness);
		const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(settled.status).toBe("done");
		await harness.waitForIdle(context);
		history.detach();
		const [result] = results(await allEntries(root));
		expect(text(result)).toBe("returned early");
		const [, child] = await toolTasks(harness);
		expect(child!.state).toMatchObject({
			status: "terminal",
			outcome: { status: "aborted", result: { kind: "nested" } },
		});
		// The aborted call's result keeps its details; programs get no partial output, which only the model read.
		const childResult = nestedResultOf(history.live(), nested, "c1/1");
		expect(childResult).toMatchObject({ isError: true, details: { step: 1 } });
		expect(childResult).not.toHaveProperty("structuredOutput");
		// The nested call ends before its caller.
		const live = history.live();
		expect(endedAt(live, "c1/1")).toBeGreaterThan(0);
		expect(endedAt(live, "c1/1")).toBeLessThan(endedAt(live, "c1"));
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		await harness.close(context);
	});

	it("records a nested call's usage under its tool", async () => {
		const setup = chatSetup();
		const usage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		};
		addTool(
			setup.registry,
			tool("paid", async () => ({ usage })),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				await api.executeTool("paid", {}, callContext);
				return {};
			}),
		);
		const { harness, root } = await runOnce(setup, [call("batch"), DONE]);
		expect((await harness.snapshot(UsageDoc, root.id, context))?.tools).toEqual({ paid: usage });
		await harness.close(context);
	});

	it("reports nested calls in pi.live.nestedTools with their parent", async () => {
		const setup = chatSetup();
		const release = deferred();
		const running = deferred();
		addTool(
			setup.registry,
			tool("slow", async (_args, api, callContext) => {
				api.output("working\n");
				await api.details({ step: 1 }, callContext);
				running.resolve();
				await release.promise;
				return { output: [{ type: "text", text: "slow done" }] };
			}),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				const result = await api.executeTool("slow", {}, callContext);
				return { output: [{ type: "text", text: text(result) }] };
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const history = await viewHistory(harness, root.id);
		expect(history.live()[0]!.nestedTools).toBeUndefined();
		const nested = nestedResults(harness);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await running.promise;
		const live = await harness.snapshot(LiveDoc, root.id, context);
		expect(live?.nestedTools).toEqual([
			{
				callId: "c1/1",
				parentCallId: "c1",
				parentTaskId: expect.any(Number),
				name: "slow",
				taskId: expect.any(Number),
				arguments: {},
				status: "running",
				output: "working\n",
				details: { step: 1 },
			},
		]);
		release.resolve();
		await submission.wait(context);
		await harness.waitForIdle(context);
		history.detach();
		const states = history.live();
		expect(startOrder(states)).toEqual(["c1", "c1/1"]);
		expect(endedAt(states, "c1/1")).toBeLessThan(endedAt(states, "c1"));
		expect(nestedResultOf(states, nested, "c1/1")).toMatchObject({ structuredOutput: "slow done", isError: false });
		// Slots name the call's task and, for a nested call, the calling one.
		const [parent, child] = await toolTasks(harness);
		expect(slotsOf(states, "c1/1").find((slot) => slot !== undefined)).toMatchObject({
			taskId: child!.id,
			parentCallId: "c1",
			parentTaskId: parent!.id,
		});
		expect(slotsOf(states, "c1").find((slot) => slot?.taskId !== undefined)).toMatchObject({ taskId: parent!.id });
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		await harness.close(context);
	});

	it("aborts nested calls with their caller", async () => {
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
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await running.promise;
		await root.abort(context);
		expect((await submission.wait(context)).status).toBe("unanswered");
		const [parent, child] = await toolTasks(harness);
		const outcome = (record: typeof parent) =>
			record!.state.status === "terminal" ? record!.state.outcome : undefined;
		expect(outcome(child)).toMatchObject({ status: "aborted", result: { kind: "nested" } });
		expect(outcome(parent)).toMatchObject({ status: "aborted", result: { kind: "model" } });
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({
			runFailure: expect.objectContaining({ reason: "aborted" }),
		});
		await harness.close(context);
	});

	it("aborts a running nested call when its caller throws", async () => {
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
				void api.executeTool("hang", {}, callContext).catch(() => {});
				await running.promise;
				throw new Error("caller failed");
			}),
		);
		const { harness, status, entries } = await runOnce(setup, [call("batch"), DONE]);
		expect(status).toBe("done");
		expect(text(results(entries)[0])).toContain("caller failed");
		const [, child] = await toolTasks(harness);
		expect(child!.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
		await harness.close(context);
	});

	it("reattaches a replay-safe caller to the nested calls it made before a restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-nested-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const setup = chatSetup();
		const echo = echoTool();
		addTool(setup.registry, echo.registration);
		const blocked = deferred();
		let runs = 0;
		addTool(
			setup.registry,
			tool(
				"batch",
				async (_args, api, callContext) => {
					runs++;
					const first = await api.executeTool("echo", { text: "a" }, callContext);
					if (runs === 1) {
						blocked.resolve();
						await aborted(callContext.abortSignal!);
					}
					// A call new to the rerun: its slot, after the reattached one's, is found and finishes.
					const second = await api.executeTool("echo", { text: "b" }, callContext);
					return { output: [{ type: "text", text: `run ${runs}: ${text(first)}, ${text(second)}` }] };
				},
				{ replay: "safe" },
			),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await blocked.promise;
		await opened.harness.close(context);

		opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect(runs).toBe(2);
		expect(echo.state.runs).toBe(2);
		expect(text(results(await allEntries(opened.root))[0])).toBe("run 2: echo a, echo b");
		const tasks = await toolTasks(opened.harness);
		expect(tasks.filter((task) => (task.input as ToolTaskInput).kind === "nested")).toHaveLength(2);
		const outcome = tasks[1]!.state.status === "terminal" ? tasks[1]!.state.outcome : undefined;
		expect((outcome?.result as ToolTaskResult | undefined)?.kind).toBe("nested");
		await opened.harness.close(context);
	});

	it("stops only the wait when a caller cancels it; the call runs on and its key returns its result", async () => {
		const setup = chatSetup();
		const cancel = new AbortController();
		const release = deferred();
		const attempts: string[] = [];
		let retry: NestedToolExecutionResult | undefined;
		addTool(
			setup.registry,
			tool("slow", async () => {
				cancel.abort(new Error("cancelled"));
				await release.promise;
				return { output: [{ type: "text", text: "slow done" }] };
			}),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				const cancelled = withAbortSignal(cancel.signal, callContext);
				await api.executeTool("slow", {}, cancelled, { key: "same" }).then(
					() => attempts.push("first done"),
					() => attempts.push("first cancelled"),
				);
				release.resolve();
				retry = await api.executeTool("slow", {}, callContext, { key: "same" });
				return {};
			}),
		);
		const { harness } = await runOnce(setup, [call("batch"), DONE]);
		expect(attempts).toEqual(["first cancelled"]);
		expect(retry).toMatchObject({ isError: false, structuredOutput: "slow done" });
		expect(await toolTasks(harness)).toHaveLength(2);
		await harness.close(context);
	});

	it("admits one nested call for a key used by concurrent calls", async () => {
		const setup = chatSetup();
		const echo = echoTool();
		addTool(setup.registry, echo.registration);
		let both: NestedToolExecutionResult[] = [];
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				both = await Promise.all([
					api.executeTool("echo", { text: "a" }, callContext, { key: "k" }),
					api.executeTool("echo", { text: "a" }, callContext, { key: "k" }),
				]);
				return {};
			}),
		);
		const { harness } = await runOnce(setup, [call("batch"), DONE]);
		expect(echo.state.runs).toBe(1);
		expect(both.map((result) => text(result))).toEqual(["echo a", "echo a"]);
		expect(await toolTasks(harness)).toHaveLength(2);
		await harness.close(context);
	});

	it("aborts left-running nested calls of a caller interrupted while it cleaned them up", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-nested-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const setup = chatSetup();
		const running = deferred();
		const cleaning = deferred();
		const release = deferred();
		let hangRuns = 0;
		addTool(
			setup.registry,
			tool("hang", async (_args, api, callContext) => {
				hangRuns++;
				api.output("partial\n");
				await api.details({ step: 1 }, callContext);
				running.resolve();
				await aborted(callContext.abortSignal!).catch(() => {});
				// The caller's cleanup waits for this abort; hold it there until the Harness closes.
				cleaning.resolve();
				await release.promise;
				throw new Error("aborted");
			}),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				void api.executeTool("hang", {}, callContext).catch(() => {});
				await running.promise;
				return { output: [{ type: "text", text: "returned early" }] };
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await cleaning.promise;
		const closed = opened.harness.close(context);
		release.resolve();
		await closed;

		opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		await opened.harness.waitForIdle(context);
		// The caller is replay-unsafe: it reports the interruption, and its cleanup aborts the nested call.
		const [result] = results(await allEntries(opened.root));
		expect(result).toMatchObject({ toolCallId: "c1", isError: true });
		expect(text(result)).toContain("Tool batch was interrupted");
		const [, child] = await toolTasks(opened.harness);
		expect(child!.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
		expect(hangRuns).toBe(1);
		expect(await opened.harness.snapshot(LiveDoc, opened.root.id, context)).toEqual({});
		await opened.harness.close(context);
	});

	it("aborts a nested call whose admission was still committing when its caller returned", async () => {
		const setup = chatSetup();
		addTool(setup.registry, echoTool().registration);
		addTool(
			setup.registry,
			tool("hang", async (_args, _api, callContext) => aborted(callContext.abortSignal!)),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				await api.executeTool("echo", { text: "warm" }, callContext, { key: "warm" });
				void api.executeTool("hang", {}, callContext, { key: "late" }).catch(() => {});
				return {};
			}),
		);
		const { harness, root, status } = await runOnce(setup, [call("batch"), DONE]);
		expect(status).toBe("done");
		const late = (await toolTasks(harness)).find((task) => {
			const input = task.input as ToolTaskInput;
			return input.kind === "nested" && input.call.name === "hang";
		});
		expect(late!.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		await harness.close(context);
	});

	it("aborts every left-running nested call before waiting for any", async () => {
		const setup = chatSetup();
		const bAborted = deferred();
		const started = { a: deferred(), b: deferred() };
		// A only stops once B was told to stop.
		addTool(
			setup.registry,
			tool("a", async () => {
				started.a.resolve();
				await bAborted.promise;
				return {};
			}),
		);
		addTool(
			setup.registry,
			tool("b", async (_args, _api, callContext) => {
				started.b.resolve();
				await aborted(callContext.abortSignal!).catch(() => {});
				bAborted.resolve();
				throw new Error("aborted");
			}),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				void api.executeTool("a", {}, callContext, { key: "a" }).catch(() => {});
				void api.executeTool("b", {}, callContext, { key: "b" }).catch(() => {});
				await Promise.all([started.a.promise, started.b.promise]);
				return {};
			}),
		);
		const { harness, status } = await runOnce(setup, [call("batch"), DONE]);
		expect(status).toBe("done");
		const nested = (await toolTasks(harness)).filter((task) => (task.input as ToolTaskInput).kind === "nested");
		expect(nested.map((task) => task.state.status)).toEqual(["terminal", "terminal"]);
		await harness.close(context);
	});

	it("rejects explicit keys that are empty, have a slash, are __proto__, or are positive integers", async () => {
		const setup = chatSetup();
		addTool(setup.registry, echoTool().registration);
		const errors: string[] = [];
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				for (const key of ["", "a/b", "__proto__", "7"]) {
					await api
						.executeTool("echo", {}, callContext, { key })
						.catch((error: Error) => errors.push(error.message));
				}
				return {};
			}),
		);
		const { harness } = await runOnce(setup, [call("batch"), DONE]);
		const rule = 'must be non-empty, without "/", not "__proto__", and not a positive integer';
		expect(errors).toEqual([
			`Nested call key "" ${rule}`,
			`Nested call key "a/b" ${rule}`,
			`Nested call key "__proto__" ${rule}`,
			`Nested call key "7" ${rule}`,
		]);
		await harness.close(context);
	});

	it("runs nested calls of nested calls, and ends them children first", async () => {
		const setup = chatSetup();
		const echo = echoTool();
		addTool(setup.registry, echo.registration);
		addTool(
			setup.registry,
			tool("inner", async (_args, api, callContext) => {
				const result = await api.executeTool("echo", { text: "deep" }, callContext, { key: "x" });
				return { output: [{ type: "text", text: text(result) }] };
			}),
		);
		addTool(
			setup.registry,
			tool("outer", async (_args, api, callContext) => {
				const result = await api.executeTool("inner", {}, callContext);
				return { output: [{ type: "text", text: text(result) }] };
			}),
		);
		setup.faux.setResponses([call("outer"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const history = await viewHistory(harness, root.id);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await harness.waitForIdle(context);
		history.detach();
		expect(text(results(await allEntries(root))[0])).toBe("echo deep");
		const [outer, inner, deep] = await toolTasks(harness);
		expect([inner!.owner, deep!.owner]).toEqual([outer!.id, inner!.id]);
		const states = history.live();
		expect(startOrder(states)).toEqual(["c1", "c1/1", "c1/1/x"]);
		expect(slotsOf(states, "c1/1/x").find((slot) => slot !== undefined)).toMatchObject({ parentCallId: "c1/1" });
		// Children end first.
		expect(endedAt(states, "c1/1/x")).toBeLessThan(endedAt(states, "c1/1"));
		expect(endedAt(states, "c1/1")).toBeLessThan(endedAt(states, "c1"));
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		await harness.close(context);
	});

	it("reports the output of several running nested calls, and shows them to a late subscriber", async () => {
		const setup = chatSetup();
		const release = deferred();
		const running = { one: deferred(), two: deferred() };
		const wrote = { one: deferred(), two: deferred() };
		addTool(
			setup.registry,
			tool("slow", async (args, api, callContext) => {
				const name = args.text as "one" | "two";
				running[name].resolve();
				await wrote[name].promise;
				api.output(`${name}\n`);
				await api.details({ name }, callContext);
				await release.promise;
				return {};
			}),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				await Promise.all([
					api.executeTool("slow", { text: "one" }, callContext),
					api.executeTool("slow", { text: "two" }, callContext),
				]);
				return {};
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await Promise.all([running.one.promise, running.two.promise]);
		const watch = await root.watch(context);
		const nestedOf = (view: ConversationView) => (view.docs["pi.live"] as LiveState).nestedTools ?? [];
		expect(nestedOf(watch.value).map((slot) => [slot.callId, slot.status])).toEqual([
			["c1/1", "running"],
			["c1/2", "running"],
		]);
		// Each value's operations rebuild the next one, the late subscriber's starting value included.
		let replayed = watch.value;
		const outputs: [string | undefined, string | undefined][] = [];
		watch.start(
			onValue(async ({ value, ops }) => {
				replayed = applyImmutable(replayed, ops);
				expect(replayed).toEqual(value);
				const [one, two] = nestedOf(value);
				outputs.push([one?.output, two?.output]);
			}),
		);
		// The second slot writes first, so a wrong slot index in the update path would show.
		wrote.two.resolve();
		await eventually(() => outputs.at(-1)?.[1] === "two\n");
		expect(outputs.at(-1)).toEqual([undefined, "two\n"]);
		wrote.one.resolve();
		await eventually(() => outputs.at(-1)?.[0] === "one\n");
		expect(outputs.at(-1)).toEqual(["one\n", "two\n"]);
		release.resolve();
		await submission.wait(context);
		await watch.stop();
		await harness.close(context);
	});

	it("commits only the status of a nested call made with progress: false, and keeps its output in the result", async () => {
		const setup = chatSetup();
		const running = deferred();
		const release = deferred();
		addTool(
			setup.registry,
			tool("chatty", async (_args, api, callContext) => {
				api.output("line\n");
				api.diagnostic({ severity: "info", message: "note" });
				await api.details({ step: 1 }, callContext);
				running.resolve();
				await release.promise;
				return {};
			}),
		);
		let result: NestedToolExecutionResult | undefined;
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				result = await api.executeTool("chatty", {}, callContext, { progress: false });
				return {};
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		// `details()` resolved before this, so a progress commit would have landed already.
		await running.promise;
		const [slot] = (await harness.snapshot(LiveDoc, root.id, context))!.nestedTools!;
		expect(slot).toEqual({
			callId: "c1/1",
			parentCallId: "c1",
			parentTaskId: expect.any(Number),
			name: "chatty",
			taskId: expect.any(Number),
			arguments: {},
			status: "running",
		});
		release.resolve();
		await submission.wait(context);
		expect(result).toMatchObject({
			structuredOutput: "line\n",
			details: { step: 1 },
			diagnostics: [{ severity: "info", message: "note" }],
		});
		await harness.close(context);
	});

	it("loses the running output of a nested call made with progress: false when it is aborted", async () => {
		const setup = chatSetup();
		const running = deferred();
		addTool(
			setup.registry,
			tool("chatty", async (_args, api, callContext) => {
				api.output("line\n");
				api.diagnostic({ severity: "info", message: "note" });
				await api.details({ step: 1 }, callContext);
				running.resolve();
				return aborted(callContext.abortSignal!);
			}),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				void api.executeTool("chatty", {}, callContext, { progress: false }).catch(() => {});
				await running.promise;
				return {};
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const history = await viewHistory(harness, root.id);
		const nested = nestedResults(harness);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await harness.waitForIdle(context);
		history.detach();
		// The abort's result is built from the slot, which never got the output.
		const result = nestedResultOf(history.live(), nested, "c1/1")!;
		expect(result).toMatchObject({ isError: true });
		expect(result).not.toHaveProperty("structuredOutput");
		expect(result).not.toHaveProperty("details");
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["aborted"]);
		await harness.close(context);
	});

	it("shows a nested call's arguments in its slot: as made, then, unbounded, as it runs with them", async () => {
		const setup = chatSetup();
		const hookEntered = deferred();
		const hookRelease = deferred();
		const running = deferred();
		const release = deferred();
		const large = "x".repeat(64 * 1024);
		addTool(
			setup.registry,
			tool("slow", async () => {
				running.resolve();
				await release.promise;
				return {};
			}),
		);
		addHooks(setup.registry, ToolTask, {
			beforeTool: async (hookCall) => {
				if (hookCall.parent === undefined) return undefined;
				hookEntered.resolve();
				await hookRelease.promise;
				return { arguments: { text: large } };
			},
		});
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				await api.executeTool("slow", { text: "asked" }, callContext);
				return {};
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const slot = async () => (await harness.snapshot(LiveDoc, root.id, context))!.nestedTools![0]!;
		await hookEntered.promise;
		expect(await slot()).toMatchObject({ status: "pending", arguments: { text: "asked" } });
		hookRelease.resolve();
		await running.promise;
		expect(await slot()).toMatchObject({ status: "running", arguments: { text: large } });
		release.resolve();
		await submission.wait(context);
		await harness.waitForIdle(context);
		// The slot showed the arguments the call runs with; the task input keeps the ones it was made with.
		const nested = (await toolTasks(harness)).find((task) => (task.input as ToolTaskInput).kind === "nested");
		expect(nested!.input as ToolTaskInput).toMatchObject({ call: { arguments: { text: "asked" } } });
		await harness.close(context);
	});

	it("runs a nested call whose repaired arguments set an optional property to undefined", async () => {
		const setup = chatSetup();
		const seen: unknown[] = [];
		addTool(
			setup.registry,
			tool(
				"repaired",
				async (args) => {
					seen.push(args);
					return {};
				},
				{ prepareArguments: () => ({ text: undefined }) },
			),
		);
		let result: NestedToolExecutionResult | undefined;
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				result = await api.executeTool("repaired", { text: "x" }, callContext);
				return {};
			}),
		);
		const { harness } = await runOnce(setup, [call("batch"), DONE]);
		expect(result).toMatchObject({ isError: false });
		expect(seen).toEqual([{}]);
		await harness.close(context);
	});

	it("finds each nested call's slot after slots in the middle were removed", async () => {
		const setup = chatSetup();
		addTool(setup.registry, echoTool().registration);
		addTool(
			setup.registry,
			tool("inner", async (_args, api, callContext) => {
				await api.executeTool("echo", { text: "m1" }, callContext);
				await api.executeTool("echo", { text: "m2" }, callContext);
				return {};
			}),
		);
		const before = deferred();
		const checked = deferred();
		let slots: { callId: string; status: string; summary?: unknown }[] = [];
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				await api.executeTool("echo", { text: "n1" }, callContext);
				// n2 makes m1 and m2 and settles, which removes them from between n2 and n3.
				await api.executeTool("inner", {}, callContext);
				await api.executeTool("echo", { text: "n3" }, callContext);
				await api.executeTool("echo", { text: "n4" }, callContext);
				const live = await api.snapshot(LiveDoc, api.conversationId, callContext);
				slots = (live?.nestedTools ?? []).map(({ callId, status, summary }) => ({ callId, status, summary }));
				before.resolve();
				await checked.promise;
				return {};
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await before.promise;
		const done = { status: "done", summary: { isError: false, durationMs: expect.any(Number) } };
		expect(slots).toEqual(["c1/1", "c1/2", "c1/3", "c1/4"].map((callId) => ({ callId, ...done })));
		checked.resolve();
		await submission.wait(context);
		await harness.close(context);
	});

	it("gives callers a result with its task ID and only diagnostics for a nested call the scheduler faulted", async () => {
		const setup = chatSetup();
		// Details that are not JSON make the result commit throw, so the task faults and stores no result.
		addTool(
			setup.registry,
			tool("echo", async () => ({ details: { count: 1n } as unknown as JsonValue })),
		);
		let result: NestedToolExecutionResult | undefined;
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				result = await api.executeTool("echo", { text: "a" }, callContext);
				return {};
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const [, child] = await toolTasks(harness);
		expect(child!.state).toMatchObject({ status: "terminal", outcome: { status: "faulted" } });
		expect(result).toEqual({
			taskId: child!.id,
			isError: true,
			diagnostics: [{ severity: "error", code: "faulted", message: expect.stringContaining("Tool echo failed") }],
		});
		await harness.close(context);
	});

	it("gives callers what a schema-less tool streamed before it threw", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("fails", async (_args, api) => {
				api.output("half way\n");
				throw new Error("broke");
			}),
		);
		let result: NestedToolExecutionResult | undefined;
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				result = await api.executeTool("fails", {}, callContext);
				return {};
			}),
		);
		const { harness } = await runOnce(setup, [call("batch"), DONE]);
		expect(result).toMatchObject({
			isError: true,
			structuredOutput: "half way\n",
			diagnostics: [{ code: "tool_error", message: "broke" }],
		});
		await harness.close(context);
	});

	it("shows a finished nested call as a done slot with its summary until its caller settles", async () => {
		const setup = chatSetup();
		const release = deferred();
		const checked = deferred();
		// Diagnostics win over output for the error text, which is cut to 500 characters.
		addTool(
			setup.registry,
			tool("verbose", async () => ({
				output: [{ type: "text", text: "ignored" }],
				isError: true,
				diagnostics: [{ severity: "error", message: "e".repeat(600) }],
			})),
		);
		const usage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		};
		addTool(setup.registry, echoTool().registration);
		addTool(
			setup.registry,
			tool("paid", async () => ({ usage })),
		);
		// An error with mixed content: programs get the list, the summary its text.
		addTool(
			setup.registry,
			tool("broken", async () => ({
				output: [
					{ type: "text", text: "bad image" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
				isError: true,
			})),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				await api.executeTool("echo", { text: "a" }, callContext);
				await api.executeTool("missing", {}, callContext);
				await api.executeTool("paid", {}, callContext);
				await api.executeTool("broken", {}, callContext);
				await api.executeTool("verbose", {}, callContext);
				checked.resolve();
				await release.promise;
				return {};
			}),
		);
		setup.faux.setResponses([call("batch"), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await checked.promise;
		const slots = (await harness.snapshot(LiveDoc, root.id, context))!.nestedTools!;
		expect(slots.map(({ callId, status, summary }) => ({ callId, status, summary }))).toEqual([
			{ callId: "c1/1", status: "done", summary: { isError: false, durationMs: expect.any(Number) } },
			{
				callId: "c1/2",
				status: "done",
				summary: { isError: true, error: "Tool missing is not available" },
			},
			{ callId: "c1/3", status: "done", summary: { isError: false, durationMs: expect.any(Number), usage } },
			{
				callId: "c1/4",
				status: "done",
				summary: { isError: true, durationMs: expect.any(Number), error: "bad image" },
			},
			{
				callId: "c1/5",
				status: "done",
				summary: { isError: true, durationMs: expect.any(Number), error: "e".repeat(500) },
			},
		]);
		release.resolve();
		await submission.wait(context);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		await harness.close(context);
	});

	it("migrates version 1 tool task input to a model-issued call", () => {
		const migrate = ToolTask.definition.migrate!;
		expect(migrate({ assistant: 3, callId: "c1" }, { phase: "call" }, 1)).toEqual({
			input: { kind: "model", assistant: 3, callId: "c1" },
			checkpoint: { phase: "call" },
		});
	});

	// #11043
	it("keeps version 2 tool task input as it is", () => {
		const migrate = ToolTask.definition.migrate!;
		const model = { kind: "model", assistant: 3, callId: "c1" };
		const nested = {
			kind: "nested",
			parent: 7,
			parentCallId: "c1",
			key: "k",
			call: { type: "toolCall", id: "c1/k", name: "echo", arguments: {} },
		};
		expect(migrate(model, { phase: "call" }, 2).input).toEqual(model);
		expect(migrate(nested, { phase: "call" }, 2).input).toEqual(nested);
	});
});

describe("tool task version 1 and 2 records", () => {
	/**
	 * Store a live tool task for call `c1` of an assistant entry, close, and rewrite its record as `version` stored it,
	 * with `checkpoint`: version 1 had `{ assistant, callId }` input, version 2 added `kind`. Returns the storage path
	 * and the task ID.
	 */
	async function storeVersion(
		setup: ChatSetup,
		checkpoint: JsonValue,
		version: 1 | 2 = 1,
	): Promise<{ path: string; id: TaskId }> {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-tool-v1-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		// No submission, so the Harness never starts scheduling and the task stays pending.
		const { harness, root } = await openChat(await openNodeSqliteStorage(path), setup);
		const id = await root.commit(async (tx) => {
			const entry = await tx.appendEntry(AssistantEntry, root.id, { model: [call("echo", { text: "old" })] });
			return tx.createTask(
				ToolTask,
				{ kind: "model", assistant: entry.id, callId: "c1" },
				{ ownership: { kind: "conversation" } },
			);
		}, context);
		await harness.close(context);
		const storage = await openNodeSqliteStorage(path);
		const record = (await storage.task(id, context))!;
		const { kind: _kind, ...version1 } = record.input as Extract<ToolTaskInput, { kind: "model" }>;
		const input = version === 1 ? version1 : record.input;
		const state = { ...record.state, checkpoint } as typeof record.state;
		await storage.commit(
			[{ type: "task", value: { ...record, version, input, state } as typeof record }],
			() => {},
			context,
		);
		await storage.close(context);
		return { path, id };
	}

	it("migrates a pending version 1 task and runs it as a model-issued call", async () => {
		const setup = chatSetup();
		const echo = echoTool();
		addTool(setup.registry, echo.registration);
		const { path, id } = await storeVersion(setup, { phase: "call" });
		const { harness, root } = await openChat(await openNodeSqliteStorage(path), setup);
		expect((await harness.getTask(id, context))?.version).toBe(1);
		harness.resume();
		const settled = await harness.waitForTask(id, context);
		expect(settled.version).toBe(3);
		expect(settled.input).toMatchObject({ kind: "model", callId: "c1" });
		expect(settled.state.outcome).toMatchObject({ status: "completed", result: { kind: "model" } });
		expect(echo.state.runs).toBe(1);
		const [result] = results(await allEntries(root));
		expect([result!.toolCallId, text(result)]).toEqual(["c1", "echo old"]);
		await harness.close(context);
	});

	it("migrates a version 1 task interrupted after intent and settles it interrupted", async () => {
		const setup = chatSetup();
		const echo = echoTool();
		addTool(setup.registry, echo.registration);
		const intent = { phase: "execute", arguments: { text: "old" }, replay: "unsafe" };
		const { path, id } = await storeVersion(setup, intent);
		const { harness, root } = await openChat(await openNodeSqliteStorage(path), setup);
		harness.resume();
		const settled = await harness.waitForTask(id, context);
		expect(settled.version).toBe(3);
		expect(settled.state.outcome).toMatchObject({ status: "failed", result: { kind: "model" } });
		expect(echo.state.runs).toBe(0);
		const [result] = results(await allEntries(root));
		expect(result).toMatchObject({ toolCallId: "c1", isError: true });
		expect(text(result)).toContain("Tool echo was interrupted");
		await harness.close(context);
	});

	// #11043
	it("reserves a stored version 2 task under version 3 and runs it as a model-issued call", async () => {
		const setup = chatSetup();
		const echo = echoTool();
		addTool(setup.registry, echo.registration);
		const { path, id } = await storeVersion(setup, { phase: "call" }, 2);
		const { harness, root } = await openChat(await openNodeSqliteStorage(path), setup);
		expect((await harness.getTask(id, context))?.version).toBe(2);
		harness.resume();
		const settled = await harness.waitForTask(id, context);
		expect(settled.version).toBe(3);
		expect(settled.input).toEqual({ kind: "model", assistant: expect.any(Number), callId: "c1" });
		expect(settled.state.outcome).toMatchObject({ status: "completed", result: { kind: "model" } });
		expect(echo.state.runs).toBe(1);
		const [result] = results(await allEntries(root));
		expect([result!.toolCallId, text(result)]).toEqual(["c1", "echo old"]);
		await harness.close(context);
	});
});
