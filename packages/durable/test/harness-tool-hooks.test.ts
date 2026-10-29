// `afterTool` runs on every result a tool task writes, also those the Harness decides without executing the tool
// (#11043).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type ToolResultMessage,
	Type,
} from "@earendil-works/pi-ai";
import {
	defineTool,
	type EntryRecord,
	type Harness,
	LiveDoc,
	MemoryStorage,
	type NestedToolExecutionResult,
	ResetEntry,
	ROOT_CONVERSATION_ID,
	type Storage,
	type TaskId,
	type ToolExecutionResult,
	type ToolHookCall,
	type ToolRegistration,
	ToolResultEntry,
	ToolTask,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, waitFor } from "./chat-support.ts";
import { addHooks, addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";

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
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-tool-hooks-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

/** Open a chat over the SQLite file at `path`; `kill()` simulates a crash: every later storage call hangs. */
async function open(path: string, setup: ChatSetup) {
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
	opened.harness.resume();
	const kill = (): void => {
		dead = true;
		killed.add(inner);
	};
	return { ...opened, kill };
}

/** Let deferred progress commits (`persistWithinMs: 0`) reach Storage before a crash. */
function stored(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 50));
}

const Parameters = Type.Object({ text: Type.Optional(Type.String()) });

function tool(
	name: string,
	execute: ToolRegistration<typeof Parameters>["execute"],
	extra: Partial<ToolRegistration<typeof Parameters>> = {},
): ToolRegistration<typeof Parameters> {
	return defineTool({ name, description: name, parameters: Parameters, execute, ...extra });
}

function calls(...list: readonly (readonly [string, Record<string, JsonValue>, string])[]): AssistantMessage {
	return fauxAssistantMessage(
		list.map(([name, args, id]) => fauxToolCall(name, args, { id })),
		{ stopReason: "toolUse" },
	);
}

const DONE = fauxAssistantMessage([fauxText("done")]);

function results(entries: readonly EntryRecord[]): Map<string, ToolResultMessage> {
	const messages = entries
		.filter((entry) => ToolResultEntry.is(entry))
		.map((entry) => entry.model![0] as ToolResultMessage);
	return new Map(messages.map((message) => [message.toolCallId, message]));
}

function text(message: ToolResultMessage | undefined): string {
	return (message?.content ?? []).map((item) => (item.type === "text" ? item.text : "")).join("|");
}

function codes(result: { readonly diagnostics?: readonly { readonly code?: string }[] }): (string | undefined)[] {
	return (result.diagnostics ?? []).map((diagnostic) => diagnostic.code);
}

async function diagnosticsOf(entries: readonly EntryRecord[], callId: string): Promise<(string | undefined)[]> {
	const entry = entries.find(
		(each) => ToolResultEntry.is(each) && (each.model![0] as ToolResultMessage).toolCallId === callId,
	);
	return codes((entry?.data ?? {}) as { diagnostics?: { code?: string }[] });
}

type Seen = { readonly call: ToolHookCall; readonly result: ToolExecutionResult };

async function toolTaskId(harness: Harness, index = 0): Promise<TaskId> {
	let id: TaskId | undefined;
	await waitFor(async () => {
		id = (await harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.tools?.[index]?.taskId;
		return id !== undefined;
	});
	return id!;
}

describe("afterTool on results the call phase decides", () => {
	// #11043
	it("sees and replaces unavailable, invalid, and blocked results, with the raw arguments", async () => {
		const setup = chatSetup();
		let ran = 0;
		const echo = tool("echo", async () => {
			ran++;
			return { output: [{ type: "text", text: "ran" }] };
		});
		addTool(setup.registry, echo);
		addTool(
			setup.registry,
			tool("gone", async () => ({ output: [] })),
		);
		const seen: Seen[] = [];
		addHooks(setup.registry, ToolTask, {
			beforeTool: (call) => {
				if (call.id === "block") return { block: "not today" };
				if (call.id === "rewrite") return { arguments: { text: { not: "a string" } } };
				return undefined;
			},
			afterTool: (call, result) => {
				seen.push({ call, result });
				return { ...result, output: [{ type: "text", text: `hooked ${call.id}` }], details: { by: "hook" } };
			},
		});
		let root!: Awaited<ReturnType<typeof openChat>>["root"];
		setup.faux.setResponses([
			async () => {
				// The tool is offered but no longer resolves when its task runs.
				await root.configure({ tools: [echo] }, context);
				return calls(
					["gone", {}, "unavailable"],
					["echo", { text: { not: "a string" } }, "invalid"],
					["echo", { text: "x" }, "rewrite"],
					["echo", {}, "block"],
				);
			},
			DONE,
		]);
		const opened = await openChat(new MemoryStorage(), setup);
		root = opened.root;
		const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(settled.status).toBe("done");
		expect(ran).toBe(0);
		const byId = new Map(seen.map((each) => [each.call.id, each]));
		expect([...byId.keys()].sort()).toEqual(["block", "invalid", "rewrite", "unavailable"]);
		expect(codes(byId.get("unavailable")!.result)).toEqual(["tool_unavailable"]);
		expect(codes(byId.get("invalid")!.result)).toEqual(["invalid_arguments"]);
		expect(codes(byId.get("rewrite")!.result)).toEqual(["invalid_arguments"]);
		expect(codes(byId.get("block")!.result)).toEqual(["blocked"]);
		// Hooks see the call as the model made it, also when it is invalid or `beforeTool` rewrote it.
		expect(byId.get("invalid")!.call.arguments).toEqual({ text: { not: "a string" } });
		expect(byId.get("rewrite")!.call.arguments).toEqual({ text: "x" });
		const entries = await allEntries(root);
		const messages = results(entries);
		for (const id of ["unavailable", "invalid", "rewrite", "block"]) {
			const message = messages.get(id)!;
			expect(message).toMatchObject({ isError: true, details: { by: "hook" } });
			expect(text(message).startsWith(`hooked ${id}|<harness>`)).toBe(true);
		}
		await opened.harness.close(context);
	});

	// #11043
	it("bounds a replacement output with the tool's limits, or the defaults for an unresolved tool", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("small", async () => ({ output: [] }), { outputLimits: { maxBytes: 10 } }),
		);
		addHooks(setup.registry, ToolTask, {
			beforeTool: () => ({ block: "no" }),
			afterTool: (call, result) => ({
				...result,
				output: [{ type: "text", text: call.id === "c2" ? "x".repeat(100) : "y".repeat(60 * 1024) }],
			}),
		});
		let root!: Awaited<ReturnType<typeof openChat>>["root"];
		setup.faux.setResponses([
			async () => {
				await root.configure({ tools: [] }, context);
				return calls(["small", {}, "c1"]);
			},
			DONE,
		]);
		const opened = await openChat(new MemoryStorage(), setup);
		root = opened.root;
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await root.configure({ tools: null }, context);
		setup.faux.setResponses([calls(["small", {}, "c2"]), DONE]);
		await (await root.submit({ type: "input", content: "again" }, context)).wait(context);
		const entries = await allEntries(root);
		const messages = results(entries);
		// Unresolved: the default 50 KB.
		const unresolved = messages.get("c1")!.content[0];
		expect(unresolved?.type === "text" && unresolved.text.length).toBe(50 * 1024);
		expect(await diagnosticsOf(entries, "c1")).toEqual(["tool_unavailable", "truncated"]);
		const bounded = messages.get("c2")!.content[0];
		expect(bounded?.type === "text" && bounded.text).toBe("x".repeat(10));
		expect(await diagnosticsOf(entries, "c2")).toEqual(["blocked", "truncated"]);
		await opened.harness.close(context);
	});

	// #11043
	it("lets a hook's terminate on a blocked call count toward the round", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("echo", async () => ({ output: [], control: { terminate: true } })),
		);
		addHooks(setup.registry, ToolTask, {
			beforeTool: (call) => (call.id === "c2" ? { block: "no" } : undefined),
			afterTool: (_call, result) => ({ ...result, control: { terminate: true } }),
		});
		setup.faux.setResponses([calls(["echo", {}, "c1"], ["echo", {}, "c2"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(settled.status).toBe("done");
		// The round terminated: no second request.
		expect(setup.faux.state.callCount).toBe(1);
		await harness.close(context);
	});

	// #11043
	it("runs on nested invalid and blocked calls; the caller gets diagnostics and details, not output", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("echo", async () => ({ output: [] })),
		);
		const nested: NestedToolExecutionResult[] = [];
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				nested.push(await api.executeTool("echo", { text: { not: "a string" } }, callContext));
				nested.push(await api.executeTool("echo", { text: "secret" }, callContext));
				nested.push(await api.executeTool("missing", {}, callContext));
				return {};
			}),
		);
		const seen: ToolHookCall[] = [];
		addHooks(setup.registry, ToolTask, {
			beforeTool: (call) => (call.arguments.text === "secret" ? { block: "no secrets" } : undefined),
			afterTool: (call, result) => {
				if (call.parent === undefined) return undefined;
				seen.push(call);
				return {
					...result,
					output: [{ type: "text", text: "dropped" }],
					structuredOutput: { dropped: true },
					details: { hooked: call.id },
					diagnostics: [...(result.diagnostics ?? []), { severity: "info", code: "hooked", message: "seen" }],
				};
			},
		});
		setup.faux.setResponses([calls(["batch", {}, "c1"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(seen.map((call) => call.id)).toEqual(["c1/1", "c1/2", "c1/3"]);
		expect(seen.every((call) => call.parent?.callId === "c1")).toBe(true);
		expect(nested.map((result) => [result.isError, codes(result)])).toEqual([
			[true, ["invalid_arguments", "hooked"]],
			[true, ["blocked", "hooked"]],
			[true, ["tool_unavailable", "hooked"]],
		]);
		expect(nested.map((result) => result.details)).toEqual([
			{ hooked: "c1/1" },
			{ hooked: "c1/2" },
			{ hooked: "c1/3" },
		]);
		// A Harness error result has no structured output, even when a hook supplies one.
		expect(nested[1]!.structuredOutput).toBeUndefined();
		expect(nested[2]!.structuredOutput).toBeUndefined();
		await harness.close(context);
	});

	// #11043
	it("gives a nested call a hook turns into a success its output as value, unless the tool has a schema", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("plain", async () => ({ output: [] })),
		);
		addTool(
			setup.registry,
			tool("typed", async () => ({ output: [], structuredOutput: { ok: true } }), {
				structuredOutputSchema: Type.Object({ ok: Type.Boolean() }),
			}),
		);
		const nested: NestedToolExecutionResult[] = [];
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				nested.push(await api.executeTool("plain", {}, callContext));
				nested.push(await api.executeTool("typed", {}, callContext));
				return {};
			}),
		);
		addHooks(setup.registry, ToolTask, {
			beforeTool: (call) => (call.parent === undefined ? undefined : { block: "no" }),
			afterTool: (call) =>
				call.parent === undefined
					? undefined
					: { output: [{ type: "text", text: `fine ${call.name}` }], structuredOutput: { ok: false } },
		});
		setup.faux.setResponses([calls(["batch", {}, "c1"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(nested.map((result) => [result.isError, result.structuredOutput])).toEqual([
			[false, "fine plain"],
			[false, undefined],
		]);
		await harness.close(context);
	});
});

describe("afterTool on results rebuilt from the slot", () => {
	/** A tool that writes output, then blocks until its invocation is cancelled. */
	function blocking(name: string, extra: Partial<ToolRegistration<typeof Parameters>> = {}) {
		const started = deferred();
		const state = { runs: 0 };
		const registration = tool(
			name,
			async (_args, api, callContext) => {
				state.runs++;
				api.output(`${name} ${"o".repeat(40)}\n`);
				await api.details({ run: state.runs }, callContext);
				started.resolve();
				return aborted(callContext.abortSignal!);
			},
			extra,
		);
		return { registration, started, state };
	}

	// #11043
	it("runs on an interrupted call; a replaced output loses the slot's truncation diagnostic", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		setup.settings.progress = { outputIntervalMs: 0, persistWithinMs: 0 };
		const limits = { outputLimits: { maxBytes: 10, retain: "tail" } } as const;
		const work = blocking("work", limits);
		const keep = blocking("keep", limits);
		addTool(setup.registry, work.registration);
		addTool(setup.registry, keep.registration);
		const seen: Seen[] = [];
		addHooks(setup.registry, ToolTask, {
			afterTool: (call, result) => {
				seen.push({ call, result });
				return call.name === "work" ? { ...result, output: [{ type: "text", text: "redacted" }] } : undefined;
			},
		});
		setup.faux.setResponses([calls(["work", {}, "c1"], ["keep", {}, "c2"]), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await work.started.promise;
		await keep.started.promise;
		await stored();
		opened.kill();

		opened = await open(path, setup);
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect(seen.map((each) => [each.call.id, codes(each.result)]).sort()).toEqual([
			["c1", ["interrupted"]],
			["c2", ["interrupted"]],
		]);
		const entries = await allEntries(opened.root);
		const messages = results(entries);
		expect(text(messages.get("c1")).startsWith("redacted|")).toBe(true);
		expect(messages.get("c1")).toMatchObject({ isError: true, details: { run: 1 } });
		expect(await diagnosticsOf(entries, "c1")).toEqual(["interrupted"]);
		// The kept output keeps its truncation diagnostic, after the hooks' result.
		expect(await diagnosticsOf(entries, "c2")).toEqual(["interrupted", "truncated"]);
		await opened.harness.close(context);
	});

	// #11043
	it("runs on an abort result, but not on the aborted results of calls that never started", async () => {
		const setup = chatSetup();
		setup.settings.toolExecution = "sequential";
		const first = blocking("first");
		addTool(setup.registry, first.registration);
		addTool(
			setup.registry,
			tool("second", async () => ({ output: [] })),
		);
		const seen: Seen[] = [];
		addHooks(setup.registry, ToolTask, {
			afterTool: (call, result) => {
				seen.push({ call, result });
				return { ...result, details: { hooked: true } };
			},
		});
		setup.faux.setResponses([calls(["first", {}, "c1"], ["second", {}, "c2"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await first.started.promise;
		await root.abort(context);
		expect((await submission.wait(context)).status).toBe("unanswered");
		expect(seen.map((each) => [each.call.id, codes(each.result)])).toEqual([["c1", ["aborted"]]]);
		const messages = results(await allEntries(root));
		expect(messages.get("c1")).toMatchObject({ isError: true, details: { hooked: true } });
		expect(messages.get("c2")?.details).toBeUndefined();
		await harness.close(context);
	});

	// #11043
	it("reports a throwing hook on an abort result and settles the result as built", async () => {
		const setup = chatSetup();
		const work = blocking("work");
		addTool(setup.registry, work.registration);
		addHooks(setup.registry, ToolTask, {
			afterTool: () => {
				throw new Error("hook failed");
			},
		});
		setup.faux.setResponses([calls(["work", {}, "c1"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await work.started.promise;
		await root.abort(context);
		expect((await submission.wait(context)).status).toBe("unanswered");
		const entries = await allEntries(root);
		expect(text(results(entries).get("c1")).startsWith(`work ${"o".repeat(40)}`)).toBe(true);
		expect(await diagnosticsOf(entries, "c1")).toEqual(["aborted"]);
		expect(setup.reports.map((error) => (error as Error).message)).toContain("hook failed");
		await harness.close(context);
	});

	// #11043
	it("settles an abort without the hooks in the abort handler's last attempt", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		setup.settings.restartLimit = 2;
		setup.settings.progress = { outputIntervalMs: 0, persistWithinMs: 0 };
		const work = blocking("work");
		addTool(setup.registry, work.registration);
		const seen: Seen[] = [];
		const hanging = deferred();
		addHooks(setup.registry, ToolTask, {
			afterTool: async (call, result) => {
				seen.push({ call, result });
				hanging.resolve();
				// Never returns: the host dies inside the hook.
				return new Promise<undefined>(() => {});
			},
		});
		setup.faux.setResponses([calls(["work", {}, "c1"]), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await work.started.promise;
		const taskId = await toolTaskId(opened.harness);
		await stored();
		void opened.root.abort(context).catch(() => {});
		await hanging.promise;
		opened.kill();

		// One restart, at the limit minus one: the attempt the scheduler would fault when cut off runs no hooks.
		opened = await open(path, setup);
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("unanswered");
		expect(seen.map((each) => codes(each.result))).toEqual([["aborted"]]);
		const entries = await allEntries(opened.root);
		expect(text(results(entries).get("c1")).startsWith(`work ${"o".repeat(40)}`)).toBe(true);
		expect(await diagnosticsOf(entries, "c1")).toEqual(["aborted"]);
		expect((await opened.harness.getTask(taskId, context))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "aborted" },
		});
		await opened.harness.close(context);
	});

	// #11043
	it("sees the held progress of an aborted call, and the result stores it", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		// Progress commits are held in memory until the result commit stores them.
		setup.settings.progress = { outputIntervalMs: 0, persistWithinMs: 60_000 };
		const work = blocking("work");
		addTool(setup.registry, work.registration);
		const seen: Seen[] = [];
		addHooks(setup.registry, ToolTask, {
			afterTool: (call, result) => {
				seen.push({ call, result });
				return undefined;
			},
		});
		setup.faux.setResponses([calls(["work", {}, "c1"]), DONE]);
		let opened = await open(path, setup);
		const submission = await opened.root.submit({ type: "input", content: "go" }, context);
		await work.started.promise;
		await opened.root.abort(context);
		expect((await submission.wait(context)).status).toBe("unanswered");
		expect(seen).toHaveLength(1);
		expect(seen[0]!.result).toMatchObject({ details: { run: 1 } });
		expect(text({ content: seen[0]!.result.output } as ToolResultMessage)).toBe(`work ${"o".repeat(40)}\n`);
		await opened.harness.close(context);

		opened = await open(path, setup);
		const message = results(await allEntries(opened.root)).get("c1");
		expect(message).toMatchObject({ isError: true, details: { run: 1 } });
		expect(text(message).startsWith(`work ${"o".repeat(40)}`)).toBe(true);
		await opened.harness.close(context);
	});

	// #11043
	it("runs on an abandoned nested call's result", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const gated = deferred();
		let gate = true;
		addTool(
			setup.registry,
			tool("gated", async () => ({ output: [] })),
		);
		addTool(
			setup.registry,
			tool("batch", async (_args, api, callContext) => {
				await api.executeTool("gated", {}, callContext);
				return {};
			}),
		);
		const seen: Seen[] = [];
		addHooks(setup.registry, ToolTask, {
			// Holds the nested call in its `call` phase, before intent, until the Harness closes.
			beforeTool: async (call, _api, hookContext) => {
				if (call.name !== "gated" || !gate) return undefined;
				gated.resolve();
				return aborted(hookContext.abortSignal!);
			},
			afterTool: (call, result) => {
				if (call.parent === undefined) return undefined;
				seen.push({ call, result });
				return { ...result, details: { hooked: true } };
			},
		});
		setup.faux.setResponses([calls(["batch", {}, "c1"]), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await gated.promise;
		await opened.harness.close(context);
		gate = false;

		opened = await open(path, setup);
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect(seen.map((each) => [each.call.id, codes(each.result)])).toEqual([["c1/1", ["abandoned"]]]);
		await opened.harness.close(context);
	});

	// #11043
	it("runs on a restart_limit result at the limit, and not once the hooks themselves were cut off", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		setup.settings.restartLimit = 1;
		setup.settings.progress = { outputIntervalMs: 0, persistWithinMs: 0 };
		const work = blocking("work");
		addTool(setup.registry, work.registration);
		const seen: Seen[] = [];
		const hanging = deferred();
		addHooks(setup.registry, ToolTask, {
			afterTool: async (call, result) => {
				seen.push({ call, result });
				hanging.resolve();
				// Never returns: the host dies inside the hook.
				return new Promise<undefined>(() => {});
			},
		});
		setup.faux.setResponses([calls(["work", {}, "c1"]), DONE]);
		let opened = await open(path, setup);
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		await work.started.promise;
		const taskId = await toolTaskId(opened.harness);
		await stored();
		opened.kill();

		// Cut off once, at the limit: the task ends itself, and the hooks run on its result.
		opened = await open(path, setup);
		await hanging.promise;
		expect(seen.map((each) => codes(each.result))).toEqual([["restart_limit"]]);
		opened.kill();

		// Past the limit: ends without the hooks.
		opened = await open(path, setup);
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect(seen).toHaveLength(1);
		expect(work.state.runs).toBe(1);
		const entries = await allEntries(opened.root);
		expect(await diagnosticsOf(entries, "c1")).toEqual(["restart_limit"]);
		expect((await opened.harness.getTask(taskId, context))?.state).toMatchObject({
			status: "terminal",
			outcome: { status: "failed", error: { detail: { reason: "restart_limit" } } },
		});
		await opened.harness.close(context);
	});
});

describe("calls to tools the request did not offer", () => {
	// #11043
	it("run afterTool inside their own tool task", async () => {
		const setup = chatSetup();
		const seen: { readonly id: string; readonly taskId: TaskId }[] = [];
		addHooks(setup.registry, ToolTask, {
			afterTool: (call, result, api) => {
				seen.push({ id: call.id, taskId: api.taskId });
				return { ...result, output: [{ type: "text", text: "try another tool" }] };
			},
		});
		setup.faux.setResponses([calls(["ghost", {}, "c1"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(seen.map((each) => each.id)).toEqual(["c1"]);
		expect(await harness.getTask(seen[0]!.taskId, context)).toMatchObject({
			kind: "pi.tool",
			input: { kind: "model", callId: "c1", unoffered: true },
		});
		const entries = await allEntries(root);
		expect(text(results(entries).get("c1")).startsWith("try another tool|")).toBe(true);
		expect(await diagnosticsOf(entries, "c1")).toEqual(["tool_unavailable"]);
		await harness.close(context);
	});

	// #11043
	it("count toward a round's terminate", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("echo", async () => ({ output: [] })),
		);
		addHooks(setup.registry, ToolTask, {
			afterTool: (_call, result) => ({ ...result, control: { terminate: true } }),
		});
		setup.faux.setResponses([calls(["echo", {}, "c1"], ["ghost", {}, "c2"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(settled.status).toBe("done");
		expect(setup.faux.state.callCount).toBe(1);
		await harness.close(context);
	});

	// #11043
	it("take their turn in a sequential round, and the last handoff in call order wins", async () => {
		const setup = chatSetup();
		setup.settings.toolExecution = "sequential";
		const order: string[] = [];
		for (const name of ["a", "b"]) {
			addTool(
				setup.registry,
				tool(name, async () => {
					order.push(name);
					return { output: [] };
				}),
			);
		}
		addHooks(setup.registry, ToolTask, {
			afterTool: (call, result) => {
				order.push(`hook ${call.id}`);
				return call.id === "c1" ? undefined : { ...result, control: { handoff: `from ${call.id}` } };
			},
		});
		setup.faux.setResponses([calls(["a", {}, "c1"], ["ghost", {}, "c2"], ["b", {}, "c3"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(order).toEqual(["a", "hook c1", "hook c2", "b", "hook c3"]);
		const resets = (await allEntries(root)).filter((entry) => ResetEntry.is(entry));
		expect(resets.map((entry) => (entry.model?.[0] as { content: string }).content)).toEqual(["from c3"]);
		await harness.close(context);
	});

	// #11043
	it("each get a tool task in a parallel round of only such calls", async () => {
		const setup = chatSetup();
		const seen: string[] = [];
		addHooks(setup.registry, ToolTask, {
			afterTool: (call) => {
				seen.push(call.id);
				return undefined;
			},
		});
		setup.faux.setResponses([calls(["ghost", {}, "c1"], ["spirit", {}, "c2"], ["ghost", {}, "c3"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(settled.status).toBe("done");
		expect(seen.sort()).toEqual(["c1", "c2", "c3"]);
		const entries = await allEntries(root);
		for (const id of ["c1", "c2", "c3"]) expect(await diagnosticsOf(entries, id)).toEqual(["tool_unavailable"]);
		// The round's results go to the next request.
		expect(setup.faux.state.callCount).toBe(2);
		await harness.close(context);
	});

	// #11043
	it("keep their flag in a version 2 generation's sequential round, also one migrated from version 1", async () => {
		for (const version of [2, 1]) {
			const path = await sqlitePath();
			const setup = chatSetup();
			setup.settings.toolExecution = "sequential";
			const started = deferred();
			let runs = 0;
			const a = tool(
				"a",
				async (_args, _api, callContext) => {
					runs++;
					if (runs > 1) return { output: [] };
					started.resolve();
					return aborted(callContext.abortSignal!);
				},
				{ replay: "safe" },
			);
			addTool(setup.registry, a);
			addTool(
				setup.registry,
				tool("ghost", async () => ({ output: [{ type: "text", text: "ran" }] })),
			);
			setup.faux.setResponses([calls(["a", {}, "c1"], ["ghost", {}, "c2"]), DONE]);
			let opened = await open(path, setup);
			let root = opened.root;
			// `ghost` is registered, but not offered to this request.
			await root.configure({ tools: [a] }, context);
			const id = (await root.submit({ type: "input", content: "go" }, context)).id;
			await started.promise;
			const live = (await opened.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))!;
			const generation = live.run!.taskId;
			expect(live.tools?.map((slot) => [slot.callId, slot.unoffered])).toEqual([
				["c1", undefined],
				["c2", true],
			]);
			expect((await opened.harness.getTask(generation, context))?.version).toBe(2);
			// The tools are offered when the round goes on: only the flag keeps `ghost` from running.
			await root.configure({ tools: null }, context);
			await opened.harness.close(context);
			if (version === 1) {
				const storage = await openNodeSqliteStorage(path);
				const record = (await storage.task(generation, context))!;
				await storage.commit([{ type: "task", value: { ...record, version: 1 } }], () => {}, context);
				await storage.close(context);
			}

			opened = await open(path, setup);
			root = opened.root;
			expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
			expect((await opened.harness.getTask(generation, context))?.version).toBe(2);
			const entries = await allEntries(root);
			expect(await diagnosticsOf(entries, "c2")).toEqual(["tool_unavailable"]);
			expect(text(results(entries).get("c2"))).not.toContain("ran");
			await opened.harness.close(context);
		}
	});

	// #11043
	it("settle unavailable, not aborted, when their sequential round is aborted before they start", async () => {
		const setup = chatSetup();
		setup.settings.toolExecution = "sequential";
		const started = deferred();
		addTool(
			setup.registry,
			tool("wait", async (_args, _api, callContext) => {
				started.resolve();
				return aborted(callContext.abortSignal!);
			}),
		);
		setup.faux.setResponses([calls(["wait", {}, "c1"], ["ghost", {}, "c2"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await started.promise;
		await root.abort(context);
		expect((await submission.wait(context)).status).toBe("unanswered");
		const entries = await allEntries(root);
		expect(await diagnosticsOf(entries, "c1")).toEqual(["aborted"]);
		expect(await diagnosticsOf(entries, "c2")).toEqual(["tool_unavailable"]);
		await harness.close(context);
	});
});
