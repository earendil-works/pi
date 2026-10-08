import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage, Type } from "@earendil-works/pi-ai";
import {
	defineDoc,
	defineTool,
	type Harness,
	LiveDoc,
	MemoryStorage,
	type TaskId,
	type ToolExecutionResult,
	type ToolRegistration,
	ToolResultEntry,
	ToolTask,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat } from "./chat-support.ts";
import { addHooks, addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";

const harnesses = new Set<Harness>();
const directories = new Set<string>();

afterEach(async () => {
	for (const harness of harnesses) await harness.close(context);
	harnesses.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function memory(setup: ChatSetup) {
	const opened = await openChat(new MemoryStorage(), setup);
	harnesses.add(opened.harness);
	return opened;
}

async function sqlite(path: string, setup: ChatSetup) {
	const opened = await openChat(await openNodeSqliteStorage(path), setup);
	harnesses.add(opened.harness);
	return opened;
}

function blockingTool(name = "work", options: Partial<ToolRegistration> = {}) {
	const started = deferred<TaskId>();
	const finished = deferred();
	let executions = 0;
	const registration = defineTool({
		name,
		description: name,
		parameters: Type.Object({}),
		...options,
		execute: async (_args, api, callContext) => {
			executions++;
			api.output("durable\n");
			api.diagnostic({ severity: "info", code: "progress", message: "checkpoint" });
			await api.details({ checkpoint: 1 }, callContext);
			// This output has not reached a progress commit when the host aborts.
			api.output("buffered\n");
			started.resolve(api.taskId);
			await Promise.race([finished.promise, aborted(callContext.abortSignal!)]);
			return { content: [{ type: "text" as const, text: "completed" }] };
		},
	});
	return { registration, started, finished, executions: () => executions };
}

function call(...names: string[]) {
	return fauxAssistantMessage(
		names.map((name) => fauxToolCall(name, {}, { id: `call:${name}` })),
		{
			stopReason: "toolUse",
		},
	);
}

const DONE = fauxAssistantMessage("done");

function resultText(result: Pick<ToolExecutionResult, "content">): string {
	return (result.content ?? []).map((item) => (item.type === "text" ? item.text : "")).join("|");
}

const AbortNotes = defineDoc<{ notes: Record<string, string> }>({
	kind: "test.abort-notes",
	version: 1,
	scope: "session",
	initial: () => ({ notes: {} }),
});

describe("tool abort hooks", () => {
	it("chains selected hooks over durable progress without changing cancellation or sibling work", async () => {
		const setup = chatSetup();
		const work = blockingTool();
		const sibling = blockingTool("sibling");
		addTool(setup.registry, work.registration);
		addTool(setup.registry, sibling.registration);
		const hooks: string[] = [];
		addHooks(setup.registry, ToolTask, {
			onAbort: async (toolCall, result, api, callContext) => {
				hooks.push("first");
				expect(toolCall.id).toBe("call:work");
				expect(api.taskId).toBe(await work.started.promise);
				expect(callContext.abortSignal?.aborted).toBe(false);
				expect(resultText(result)).toBe("durable\n");
				expect(result.details).toEqual({ checkpoint: 1 });
				expect(result.diagnostics?.map((item) => item.code)).toEqual(["progress", "aborted"]);
				const note = (await api.snapshot(AbortNotes, callContext))!.notes[String(api.taskId)]!;
				return { ...result, content: [...(result.content ?? []), { type: "text", text: note }] };
			},
			afterTool: (toolCall) => {
				hooks.push(`after:${toolCall.name}`);
				return undefined;
			},
		});
		addHooks(setup.registry, ToolTask, {
			onAbort: (_call, result) => {
				hooks.push("second");
				expect(resultText(result)).toContain("Use a narrower search");
				// Controls affect completed calls only, not the aborted task's outcome.
				return { ...result, details: { annotated: true }, control: { terminate: true } };
			},
		});
		let modelResult: ToolResultMessage | undefined;
		setup.faux.setResponses([
			call("work", "sibling"),
			(request) => {
				modelResult = request.messages.find(
					(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "work",
				);
				return DONE;
			},
		]);
		const { harness, root } = await memory(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const taskId = await work.started.promise;
		const siblingId = await sibling.started.promise;
		await harness.commit(async (tx) => {
			(await tx.doc(AbortNotes)).notes[String(taskId)] = "Use a narrower search";
		}, context);
		expect(await harness.abortTask(taskId, context)).toBe("marked");
		expect((await harness.waitForTask(taskId, context)).state.outcome).toMatchObject({ status: "aborted" });
		expect((await harness.getTask(siblingId, context))!.abortRequested).toBe(false);
		sibling.finished.resolve();
		expect((await submission.wait(context)).status).toBe("done");
		expect(hooks).toEqual(["first", "second", "after:sibling"]);
		const entries = (await allEntries(root)).filter(ToolResultEntry.is);
		const result = entries.find(
			(entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].toolName === "work",
		)!.model![0] as ToolResultMessage;
		expect(result).toEqual(modelResult);
		expect(result).toMatchObject({ isError: true, details: { annotated: true } });
		expect(resultText(result)).toContain("durable\n|Use a narrower search");
		expect(resultText(result)).not.toContain("buffered");
		expect(result.durationMs).toBeUndefined();
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		expect(setup.reports).toEqual([]);
	});

	it("reports ordinary hook failures and continues the replacement chain", async () => {
		const setup = chatSetup();
		const work = blockingTool();
		addTool(setup.registry, work.registration);
		const failure = new Error("annotation unavailable");
		addHooks(setup.registry, ToolTask, {
			onAbort: () => {
				throw failure;
			},
		});
		addHooks(setup.registry, ToolTask, {
			onAbort: (_call, result) => ({ ...result, details: { laterHook: true } }),
		});
		setup.faux.setResponses([call("work"), DONE]);
		const { harness, root } = await memory(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const taskId = await work.started.promise;
		await harness.abortTask(taskId, context);
		await submission.wait(context);
		const entry = (await allEntries(root)).find(ToolResultEntry.is)!;
		expect(entry.model?.[0]).toMatchObject({ isError: true, details: { laterHook: true } });
		expect(setup.reports).toEqual([failure]);
	});

	it("runs before execution when aborted during beforeTool, without constructing an environment", async () => {
		const setup = chatSetup();
		const work = blockingTool();
		addTool(setup.registry, work.registration);
		const reached = deferred<TaskId>();
		let asks = 0;
		addHooks(setup.registry, ToolTask, {
			beforeTool: async (_call, api, callContext) => {
				reached.resolve(api.taskId);
				await aborted(callContext.abortSignal!);
			},
			onAbort: (_call, result) => {
				asks++;
				expect(result).toMatchObject({ content: [], isError: true });
				return { ...result, content: [{ type: "text", text: "Cancelled before execution" }] };
			},
		});
		setup.faux.setResponses([call("work"), DONE]);
		let environments = 0;
		const { harness, root } = await openChat(new MemoryStorage(), setup, {
			env: () => {
				environments++;
				return undefined;
			},
		});
		harnesses.add(harness);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await reached.promise;
		const beforeAbort = environments;
		await harness.abortTask(await reached.promise, context);
		await submission.wait(context);
		// The continuation's request constructs one environment; abort constructs none.
		expect(environments).toBe(beforeAbort + 1);
		expect(work.executions()).toBe(0);
		expect(asks).toBe(1);
	});

	it("bounds hook content using the tool's limits and keeps harness diagnostics last", async () => {
		const setup = chatSetup();
		const work = blockingTool("work", { outputLimits: { maxLines: 2, maxBytes: 4096, retain: "tail" } });
		addTool(setup.registry, work.registration);
		addHooks(setup.registry, ToolTask, {
			onAbort: (_call, result) => ({ ...result, content: [{ type: "text", text: "one\ntwo\nthree\nfour" }] }),
		});
		setup.faux.setResponses([call("work"), DONE]);
		const { harness, root } = await memory(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await harness.abortTask(await work.started.promise, context);
		await submission.wait(context);
		const entry = (await allEntries(root)).find(ToolResultEntry.is)!;
		const result = entry.model![0] as ToolResultMessage;
		expect(result.content[0]).toEqual({ type: "text", text: "three\nfour" });
		expect(entry.data).toMatchObject({
			diagnostics: [{ code: "progress" }, { code: "aborted" }, { code: "truncated" }],
		});
		expect(resultText(result)).toContain("Output truncated to its end");
		expect((await harness.waitForTask(await work.started.promise, context)).state.outcome.status).toBe("aborted");
	});

	it("does not re-bound retained output when an unchanged result outlives the tool's limits", async () => {
		const setup = chatSetup();
		const work = blockingTool();
		addTool(setup.registry, work.registration);
		addHooks(setup.registry, ToolTask, { onAbort: () => undefined });
		setup.faux.setResponses([call("work"), DONE]);
		const { harness, root } = await memory(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const taskId = await work.started.promise;
		addTool(setup.registry, { ...work.registration, outputLimits: { maxBytes: 1 } });
		await harness.abortTask(taskId, context);
		await submission.wait(context);
		const entry = (await allEntries(root)).find(ToolResultEntry.is)!;
		expect((entry.model![0] as ToolResultMessage).content[0]).toEqual({ type: "text", text: "durable\n" });
		expect(entry.data).toMatchObject({ diagnostics: [{ code: "progress" }, { code: "aborted" }] });
	});

	it("settles an abort even when the tool was uninstalled, using default content bounds", async () => {
		const setup = chatSetup();
		const work = blockingTool();
		const installed = addTool(setup.registry, work.registration);
		addHooks(setup.registry, ToolTask, {
			onAbort: (_call, result) => ({ ...result, content: [{ type: "text", text: "Cancelled by policy" }] }),
		});
		setup.faux.setResponses([call("work"), DONE]);
		const { harness, root } = await memory(setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const taskId = await work.started.promise;
		installed.dispose();
		await harness.abortTask(taskId, context);
		await submission.wait(context);
		const entry = (await allEntries(root)).find(ToolResultEntry.is)!;
		expect(resultText(entry.model![0] as ToolResultMessage)).toContain("Cancelled by policy");
		expect((await harness.waitForTask(taskId, context)).state.outcome.status).toBe("aborted");
	});

	it("replays the hook after close before settlement, retaining the abort mark and application note", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-abort-hook-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const setup = chatSetup();
		const work = blockingTool();
		addTool(setup.registry, work.registration);
		const reached = deferred();
		let asks = 0;
		const notes: string[] = [];
		addHooks(setup.registry, ToolTask, {
			onAbort: async (_call, result, api, callContext) => {
				asks++;
				const note = (await api.snapshot(AbortNotes, callContext))!.notes[String(api.taskId)]!;
				notes.push(note);
				if (asks === 1) {
					reached.resolve();
					await aborted(callContext.abortSignal!);
				}
				return { ...result, content: [...(result.content ?? []), { type: "text", text: note }] };
			},
		});
		setup.faux.setResponses([call("work"), DONE]);
		let opened = await sqlite(path, setup);
		const submissionId = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		const taskId = await work.started.promise;
		await opened.harness.commit(async (tx) => {
			(await tx.doc(AbortNotes)).notes[String(taskId)] = "User requested cancellation";
		}, context);
		await opened.harness.abortTask(taskId, context);
		await reached.promise;
		await opened.harness.close(context);
		opened = await sqlite(path, setup);
		const submission = (await opened.harness.submission(submissionId, context))!;
		expect((await submission.wait(context)).status).toBe("done");
		expect(asks).toBe(2);
		expect(notes).toEqual(["User requested cancellation", "User requested cancellation"]);
		expect(work.executions()).toBe(1);
		const entries = (await allEntries(opened.root)).filter(ToolResultEntry.is);
		expect(entries).toHaveLength(1);
		expect(resultText(entries[0]!.model![0] as ToolResultMessage)).toContain("User requested cancellation");
		expect((await opened.harness.waitForTask(taskId, context)).state.outcome).toMatchObject({ status: "aborted" });
		expect(setup.reports).toEqual([]);
	});

	it("does not treat host close and unsafe recovery as an explicit tool abort", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-abort-hook-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const setup = chatSetup();
		const work = blockingTool();
		addTool(setup.registry, work.registration);
		let asks = 0;
		addHooks(setup.registry, ToolTask, {
			onAbort: () => {
				asks++;
				return undefined;
			},
		});
		setup.faux.setResponses([call("work"), DONE]);
		let opened = await sqlite(path, setup);
		const submissionId = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		const taskId = await work.started.promise;
		await opened.harness.close(context);
		expect(asks).toBe(0);
		opened = await sqlite(path, setup);
		await (await opened.harness.submission(submissionId, context))!.wait(context);
		expect(asks).toBe(0);
		expect((await opened.harness.waitForTask(taskId, context)).state.outcome.status).toBe("failed");
	});
});
