import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type SystemMessage,
	type ToolResultMessage,
	Type,
} from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type Conversation,
	configure,
	defineExtension,
	defineTask,
	defineTool,
	type EntryRecord,
	GenerationTask,
	type Harness,
	hook,
	LiveDoc,
	MemoryStorage,
	type SubmissionId,
	section,
	type ToolRegistration,
	ToolResultEntry,
	ToolTask,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { createBashTool, createEditTool, createReadTool } from "../src/tools/index.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf } from "./chat-support.ts";
import { addHooks, addTask, addTool, type Installed } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";

const EchoParameters = Type.Object({ text: Type.Optional(Type.String()) });
type Echo = ToolRegistration<typeof EchoParameters>;
type Execute = Echo["execute"];

function tool(name: string, execute: Execute, extra: Partial<Echo> = {}): Echo {
	return defineTool({ name, description: `The ${name} tool`, parameters: EchoParameters, execute, ...extra });
}

/** A tool-calling answer with one call per `[name, args, id]`. */
function calls(...list: readonly (readonly [string, Record<string, JsonValue>, string])[]): AssistantMessage {
	return fauxAssistantMessage(
		list.map(([name, args, id]) => fauxToolCall(name, args, { id })),
		{ stopReason: "toolUse" },
	);
}

const DONE = fauxAssistantMessage([fauxText("done")]);

async function run(
	setup: ChatSetup,
	responses: FauxResponseStep[],
	prepare?: (harness: Harness, root: Conversation) => Promise<void>,
	options: Parameters<typeof openChat>[2] = {},
): Promise<{ harness: Harness; root: Conversation; entries: EntryRecord[]; status: string }> {
	setup.faux.setResponses(responses);
	const { harness, root } = await openChat(new MemoryStorage(), setup, options);
	await prepare?.(harness, root);
	const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
	return { harness, root, entries: await allEntries(root), status: settled.status };
}

function results(entries: readonly EntryRecord[]): ToolResultMessage[] {
	return entries.filter((entry) => ToolResultEntry.is(entry)).map((entry) => entry.model![0] as ToolResultMessage);
}

function resultText(message: ToolResultMessage): string {
	return message.content.map((item) => (item.type === "text" ? item.text : `[${item.type}]`)).join("|");
}

describe("tool round", () => {
	it("runs input, tool call, tool result, and answer, and settles the input", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("echo", async (args) => ({
				content: [{ type: "text", text: `echo ${args.text}` }],
			})),
		);
		const { harness, root, entries, status } = await run(setup, [calls(["echo", { text: "hi" }, "c1"]), DONE]);
		expect(status).toBe("done");
		expect(entries.map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.system",
			"pi.assistant",
			"pi.tool-result",
			"pi.assistant",
		]);
		const system = entries[1]!.model![0] as SystemMessage;
		expect(system.toolsAdded).toEqual([
			{ name: "echo", description: "The echo tool", parameters: expect.any(Object) },
		]);
		const [result] = results(entries);
		expect(result).toMatchObject({ toolCallId: "c1", toolName: "echo", isError: false });
		expect(resultText(result!)).toBe("echo hi");
		expect(ToolResultEntry.is(entries[3]) && entries[3].data).toEqual({ diagnostics: [] });
		expect(entries[3]!.byTaskId).toBeDefined();
		// The second request sees the tool result right after its call.
		expect(setup.faux.state.callCount).toBe(2);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		await harness.close(context);
	});

	it("answers calls to tools the request did not offer without a task", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("echo", async () => ({ content: [] })),
		);
		const { harness, root, entries, status } = await run(setup, [
			calls(["ghost", {}, "c1"], ["echo", {}, "c2"]),
			DONE,
		]);
		expect(status).toBe("done");
		const [ghost, echo] = results(entries);
		expect(ghost).toMatchObject({ toolCallId: "c1", isError: true });
		expect(resultText(ghost!)).toBe("<harness>\n[error] Tool ghost is not available\n</harness>");
		expect(echo).toMatchObject({ toolCallId: "c2", isError: false });
		const ghostEntry = entries.find((entry) => ToolResultEntry.is(entry) && entry.model![0]!.role === "toolResult");
		expect(ghostEntry?.data).toEqual({
			diagnostics: [{ severity: "error", code: "tool_unavailable", message: "Tool ghost is not available" }],
		});
		const tasks = await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 20), context);
		expect(tasks.items.filter((task) => task.kind === "pi.tool")).toHaveLength(1);
		await harness.close(context);
	});

	it("answers a call to a tool deactivated after preparation with tool_unavailable", async () => {
		const setup = chatSetup();
		const seen: string[] = [];
		addTool(
			setup.registry,
			tool("echo", async () => {
				seen.push("ran");
				return { content: [] };
			}),
		);
		let root!: Conversation;
		const deactivate: FauxResponseStep = async () => {
			await root.configure({ tools: [] }, context);
			return calls(["echo", {}, "c1"]);
		};
		const result = await run(setup, [deactivate, DONE], async (_harness, conversation) => {
			root = conversation;
		});
		expect(seen).toEqual([]);
		expect(resultText(results(result.entries)[0]!)).toBe("<harness>\n[error] Tool echo is not available\n</harness>");
		// The next preparation removes it.
		const systems = result.entries.filter((entry) => entry.kind === "pi.system");
		expect((systems.at(-1)!.model![0] as SystemMessage).toolsRemoved).toEqual([{ name: "echo" }]);
		await result.harness.close(context);
	});

	it("removes unregistered active tools from the offer and adds them back after re-registration", async () => {
		const setup = chatSetup();
		const echo = tool("echo", async () => ({ content: [] }));
		const registration = addTool(setup.registry, echo);
		const first = await run(setup, [DONE]);
		registration.dispose();
		setup.faux.setResponses([calls(["echo", {}, "c1"]), DONE]);
		const second = await (await first.root.submit({ type: "input", content: "again" }, context)).wait(context);
		expect(second.status).toBe("done");
		let entries = await allEntries(first.root);
		const removal = entries.filter((entry) => entry.kind === "pi.system").at(-1)!.model![0] as SystemMessage;
		expect(removal.toolsRemoved).toEqual([{ name: "echo" }]);
		expect(results(entries)[0]).toMatchObject({ isError: true });
		// The stored agent is not rewritten; the tool is only not resolved.
		expect((await first.root.agent(context)).tools).toEqual([]);

		addTool(setup.registry, echo);
		setup.faux.setResponses([DONE]);
		await (await first.root.submit({ type: "input", content: "back" }, context)).wait(context);
		entries = await allEntries(first.root);
		const addition = entries.filter((entry) => entry.kind === "pi.system").at(-1)!.model![0] as SystemMessage;
		expect(addition.toolsAdded?.map((declared) => declared.name)).toEqual(["echo"]);
		await first.harness.close(context);
	});

	it("produces tool_unavailable when the implementation is unregistered before its task runs", async () => {
		const setup = chatSetup();
		let second!: Installed;
		addTool(
			setup.registry,
			tool(
				"first",
				async () => {
					second.dispose();
					return { content: [] };
				},
				{ executionMode: "sequential" },
			),
		);
		second = addTool(
			setup.registry,
			tool("second", async () => ({ content: [{ type: "text", text: "ran" }] })),
		);
		const { harness, entries, status } = await run(setup, [calls(["first", {}, "c1"], ["second", {}, "c2"]), DONE]);
		expect(status).toBe("done");
		const [, late] = results(entries);
		expect(resultText(late!)).toBe("<harness>\n[error] Tool second is not available\n</harness>");
		await harness.close(context);
	});

	it("reads the execution mode when a round starts and keeps it for the round", async () => {
		const setup = chatSetup();
		const events: string[] = [];
		const slow =
			(name: string): Execute =>
			async () => {
				events.push(`start ${name}`);
				// Changed after the round started: not seen by this round.
				setup.settings.toolExecution = "parallel";
				await new Promise((resolve) => setTimeout(resolve, 20));
				events.push(`end ${name}`);
				return { content: [] };
			};
		addTool(setup.registry, tool("a", slow("a")));
		addTool(setup.registry, tool("b", slow("b")));
		// Changed while the model request runs: the round that follows uses it.
		const request: FauxResponseStep = () => {
			setup.settings.toolExecution = "sequential";
			return calls(["a", {}, "c1"], ["b", {}, "c2"]);
		};
		const { harness } = await run(setup, [request, DONE]);
		expect(events).toEqual(["start a", "end a", "start b", "end b"]);
		await harness.close(context);
	});

	it("runs a round in parallel by default and sequentially when configured or required by a tool", async () => {
		const trace = async (setup: ChatSetup, prepare?: (root: Conversation) => Promise<void>): Promise<string[]> => {
			const events: string[] = [];
			const slow =
				(name: string): Execute =>
				async () => {
					events.push(`start ${name}`);
					await new Promise((resolve) => setTimeout(resolve, 20));
					events.push(`end ${name}`);
					return { content: [] };
				};
			if (setup.registry.snapshot().extension("tool:a") === undefined) addTool(setup.registry, tool("a", slow("a")));
			if (setup.registry.snapshot().extension("tool:b") === undefined) addTool(setup.registry, tool("b", slow("b")));
			const result = await run(setup, [calls(["a", {}, "c1"], ["b", {}, "c2"]), DONE], (_harness, root) =>
				prepare === undefined ? Promise.resolve() : prepare(root),
			);
			await result.harness.close(context);
			return events;
		};
		expect((await trace(chatSetup())).slice(0, 2)).toEqual(["start a", "start b"]);
		const configured = chatSetup();
		configured.settings.toolExecution = "sequential";
		const sequential = await trace(configured);
		expect(sequential).toEqual(["start a", "end a", "start b", "end b"]);
		const perTool = chatSetup();
		const events: string[] = [];
		addTool(
			perTool.registry,
			tool(
				"a",
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					events.push("a");
					return { content: [] };
				},
				{ executionMode: "sequential" },
			),
		);
		addTool(
			perTool.registry,
			tool("b", async () => {
				events.push("b");
				return { content: [] };
			}),
		);
		const result = await run(perTool, [calls(["a", {}, "c1"], ["b", {}, "c2"]), DONE]);
		const tasks = await result.harness.commit((tx) => tx.scanTasks({ conversationId: result.root.id }, 20), context);
		const tools = tasks.items.filter((task) => task.kind === "pi.tool").sort((a, b) => a.id - b.id);
		// The generation owns both tools and creates the second only after the first ended.
		const [generation] = tasks.items.filter((task) => task.kind === "pi.generation");
		expect(tools.map((task) => task.owner)).toEqual([generation!.id, generation!.id]);
		expect(events).toEqual(["a", "b"]);
		await result.harness.close(context);
	});
});

describe("tool results", () => {
	it("uses retained output and the last details when the result omits them, with diagnostics in order", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool(
				"log",
				async (_args, api) => {
					api.output("line 1\n");
					api.output(new TextEncoder().encode("line 2\nline 3\n"));
					api.diagnostic({ severity: "info", message: "from api" });
					await api.details({ step: 1 }, context);
					await api.details({ step: 2 }, context);
					return { diagnostics: [{ severity: "warn", message: "from result" }] };
				},
				{ outputLimits: { maxLines: 2 } },
			),
		);
		const { harness, entries } = await run(setup, [calls(["log", {}, "c1"]), DONE]);
		const [result] = results(entries);
		expect(result!.details).toEqual({ step: 2 });
		expect(resultText(result!)).toBe(
			"line 1\nline 2\n|<harness>\n[info] from api\n[warn] from result\n[warn] Output truncated to its beginning: 1 lines, 7 bytes dropped\n</harness>",
		);
		const entry = entries.find((candidate) => ToolResultEntry.is(candidate));
		expect(ToolResultEntry.is(entry) && entry.data.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			undefined,
			undefined,
			"truncated",
		]);
		await harness.close(context);
	});

	it("offers the tail window with the configured pace, not a head window, and accepts skipped output", async () => {
		const setup = { ...chatSetup(), settings: { progress: { outputIntervalMs: 250 } } };
		const windows: unknown[] = [];
		addTool(
			setup.registry,
			tool(
				"tailed",
				async (_args, api) => {
					windows.push(api.outputWindow);
					api.output("dropped\n");
					api.output("x\ny\n", { bytes: 8, newlines: 1, endsWithNewline: true });
					return {};
				},
				{ outputLimits: { maxLines: 1, retain: "tail" } },
			),
		);
		addTool(
			setup.registry,
			tool(
				"headed",
				async (_args, api) => {
					windows.push(api.outputWindow);
					return {};
				},
				{ outputLimits: { maxLines: 1 } },
			),
		);
		const { harness, entries } = await run(setup, [calls(["tailed", {}, "c1"], ["headed", {}, "c2"]), DONE]);
		expect(windows).toContainEqual({
			maxBytes: 50 * 1024,
			maxLines: 1,
			minIntervalMs: 250,
			bytesPerSecond: 100 * 1024,
		});
		expect(windows).toContainEqual(undefined);
		// 8 bytes written, 8 skipped, then "x\n" dropped by the window: 3 lines, 18 bytes in all.
		expect(resultText(results(entries).find((result) => result.toolCallId === "c1")!)).toBe(
			"y\n|<harness>\n[warn] Output truncated to its end: 3 lines, 18 bytes dropped\n</harness>",
		);
		await harness.close(context);
	});

	it("bounds explicit text content and keeps other content", async () => {
		const setup = chatSetup();
		const image = { type: "image", data: "AAAA", mimeType: "image/png" } as const;
		addTool(
			setup.registry,
			tool(
				"big",
				async () => ({
					content: [{ type: "text", text: "a\nb\n" }, image, { type: "text", text: "c\nd\n" }],
				}),
				{ outputLimits: { maxLines: 2, retain: "tail" } },
			),
		);
		const { harness, entries } = await run(setup, [calls(["big", {}, "c1"]), DONE]);
		expect(resultText(results(entries)[0]!)).toBe(
			"[image]|c\nd\n|<harness>\n[warn] Output truncated to its end: 2 lines, 4 bytes dropped\n</harness>",
		);
		await harness.close(context);
	});

	it("turns a throw into a tool_error result with the partial output", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("fail", async (_args, api) => {
				api.output("partial\n");
				throw new Error("boom");
			}),
		);
		const { harness, entries, status } = await run(setup, [calls(["fail", {}, "c1"]), DONE]);
		expect(status).toBe("done");
		const [result] = results(entries);
		expect(result!.isError).toBe(true);
		expect(resultText(result!)).toBe("partial\n|<harness>\n[error] boom\n</harness>");
		await harness.close(context);
	});

	it("validates arguments before and after beforeTool and applies blocks and replacements", async () => {
		const setup = chatSetup();
		const seen: { text?: string }[] = [];
		addTool(
			setup.registry,
			tool("echo", async (args) => {
				seen.push(args);
				return { content: [] };
			}),
		);
		addHooks(setup.registry, ToolTask, {
			beforeTool: (call) => {
				if (call.id === "block") return { block: "not today" };
				if (call.id === "throw") throw new Error("hook failed");
				if (call.id === "bad") return { arguments: { text: { not: "a string" } } };
				return { arguments: { text: `${call.arguments.text}!` } };
			},
		});
		const { harness, entries } = await run(setup, [
			calls(
				["echo", { text: 1 as unknown as string }, "coerced"],
				["echo", { text: { not: "a string" } }, "invalid"],
				["echo", {}, "block"],
				["echo", {}, "throw"],
				["echo", { text: "x" }, "bad"],
				["echo", { text: "x" }, "ok"],
			),
			DONE,
		]);
		// Parallel tools append their results in completion order.
		const byId = new Map(results(entries).map((result) => [result.toolCallId, [result.isError, resultText(result)]]));
		expect(byId.get("block")).toEqual([true, "<harness>\n[error] Tool call blocked: not today\n</harness>"]);
		expect(byId.get("throw")).toEqual([true, "<harness>\n[error] Tool call blocked: hook failed\n</harness>"]);
		expect(byId.get("bad")![0]).toBe(true);
		expect(byId.get("bad")![1]).toContain("Validation failed");
		expect(byId.get("ok")).toEqual([false, ""]);
		expect(byId.get("invalid")![0]).toBe(true);
		expect(byId.get("invalid")![1]).toContain("Validation failed");
		// pi-ai coerces a number to a string before the first validation.
		expect(byId.get("coerced")).toEqual([false, ""]);
		expect(seen).toEqual(expect.arrayContaining([{ text: "1!" }, { text: "x!" }]));
		expect(seen).toHaveLength(2);
		await harness.close(context);
	});

	it("repairs arguments with prepareArguments before validation, and a throwing repair is invalid", async () => {
		const setup = chatSetup();
		const seen: { text?: string }[] = [];
		addTool(
			setup.registry,
			tool(
				"echo",
				async (args) => {
					seen.push(args);
					return { content: [] };
				},
				{
					prepareArguments: (args) => {
						const text = (args as { text?: unknown }).text;
						if (text === "throw") throw new Error("cannot repair");
						return typeof text === "number" ? { text: `#${text}` } : (args as { text?: string });
					},
				},
			),
		);
		const { harness, entries } = await run(setup, [
			calls(["echo", { text: 7 as unknown as string }, "fixed"], ["echo", { text: "throw" }, "broken"]),
			DONE,
		]);
		const byId = new Map(results(entries).map((result) => [result.toolCallId, resultText(result)]));
		expect(byId.get("fixed")).toBe("");
		expect(byId.get("broken")).toBe("<harness>\n[error] cannot repair\n</harness>");
		expect(seen).toEqual([{ text: "#7" }]);
		// The stored call keeps what the model sent.
		const call = (entries[2]!.model![0] as AssistantMessage).content.find((item) => item.type === "toolCall");
		expect(call?.type === "toolCall" && call.arguments).toEqual({ text: 7 });
		await harness.close(context);
	});

	it("lets the first beforeTool block win and skips later handlers", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("echo", async () => ({ content: [] })),
		);
		const asked: string[] = [];
		addHooks(setup.registry, ToolTask, {
			beforeTool: () => {
				asked.push("first");
				return { block: "first says no" };
			},
		});
		addHooks(setup.registry, ToolTask, {
			beforeTool: () => {
				asked.push("second");
				return { block: "second says no" };
			},
		});
		const { harness, entries } = await run(setup, [calls(["echo", {}, "c1"]), DONE]);
		expect(asked).toEqual(["first"]);
		expect(resultText(results(entries)[0]!)).toBe("<harness>\n[error] Tool call blocked: first says no\n</harness>");
		await harness.close(context);
	});

	it("chains afterTool replacements and observes the round with afterTools", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("echo", async () => ({ content: [{ type: "text", text: "raw" }] })),
		);
		addHooks(setup.registry, ToolTask, {
			afterTool: (_call, result) => ({ ...result, content: [{ type: "text", text: "first" }] }),
		});
		addHooks(setup.registry, ToolTask, {
			afterTool: (_call, result) => ({ ...result, details: { replaced: resultText(result as ToolResultMessage) } }),
		});
		const observed: unknown[] = [];
		addHooks(setup.registry, GenerationTask, {
			afterTools: (assistant, entries) => void observed.push(assistant, entries),
		});
		const { harness, entries } = await run(setup, [calls(["echo", {}, "c1"]), DONE]);
		const [result] = results(entries);
		expect(resultText(result!)).toBe("first");
		expect(result!.details).toEqual({ replaced: "first" });
		const resultEntry = entries.find((entry) => ToolResultEntry.is(entry))!;
		expect(observed).toEqual([entries[2]!.id, [resultEntry.id]]);
		await harness.close(context);
	});

	it("runs the hooks of the selected extensions; a task-owned child copies its owner's selection", async () => {
		const setup = chatSetup();
		const calledIn: number[] = [];
		const Echo = defineExtension({ name: "echo", tools: [tool("echo", async () => ({ content: [] }))] });
		const Audit = defineExtension({
			name: "audit",
			hooks: [hook(ToolTask, { beforeTool: (_call, api) => void calledIn.push(api.conversationId) })],
		});
		setup.registry.install(Echo);
		setup.registry.install(Audit);
		// Audit is installed but not in the default selection.
		setup.settings.extensions = [Echo];
		const first = await run(setup, [DONE]);
		await first.root.configure({ extensions: { add: [Audit] } }, context);
		// An owner task no registered definition takes stays live and pending.
		const owner = defineTask<Record<string, never>, { phase: "never" }, null>({
			name: "test.owner",
			version: 1,
			initial: () => ({ phase: "never" }),
			phases: { never: async () => {} },
			abort: async () => {},
		});
		const childId = await first.harness.commit(async (tx) => {
			const taskId = await tx.createTask(
				owner,
				{},
				{ ownership: { kind: "conversation" }, conversationId: first.root.id },
			);
			return (await tx.createConversation({ ownership: { kind: "task", taskId } })).id;
		}, context);
		const child = (await first.harness.conversation(childId, context))!;
		const other = await first.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } },
			context,
		);
		for (const conversation of [first.root, child, other]) {
			setup.faux.setResponses([calls(["echo", {}, "c1"]), DONE]);
			await (await conversation.submit({ type: "input", content: "go" }, context)).wait(context);
		}
		expect(calledIn).toEqual([first.root.id, child.id]);
		await first.harness.close(context);
	});

	it("applies addTools and terminates only when every result of the round asks to", async () => {
		const setup = chatSetup();
		const stop = tool("stop", async () => ({ content: [], control: { terminate: true } }));
		const grow = tool("grow", async () => ({ content: [], control: { addTools: ["extra", "stop"] } }));
		addTool(setup.registry, stop);
		addTool(setup.registry, grow);
		addTool(
			setup.registry,
			tool("extra", async () => ({ content: [] })),
		);
		const first = await run(setup, [calls(["stop", {}, "c1"])], async (_harness, root) => {
			await root.configure({ tools: [stop, grow] }, context);
		});
		expect(first.status).toBe("done");
		expect(first.entries.at(-1)!.kind).toBe("pi.tool-result");
		const settled = await first.harness.commit((tx) => tx.scanTasks({ conversationId: first.root.id }, 20), context);
		expect(settled.items.every((task) => task.state.status === "terminal")).toBe(true);

		setup.faux.setResponses([calls(["stop", {}, "c1"], ["grow", {}, "c2"]), DONE]);
		const second = await (await first.root.submit({ type: "input", content: "again" }, context)).wait(context);
		expect(second.status).toBe("done");
		expect((await allEntries(first.root)).at(-1)!.kind).toBe("pi.assistant");
		// addTools appends to the stored tool array, skipping names it already holds.
		expect((await first.harness.snapshot(AgentDoc, first.root.id, context))?.tools).toEqual([
			"stop",
			"grow",
			"extra",
		]);
		await first.harness.close(context);
	});
});

describe("generation hooks", () => {
	it("replaces request messages, observes responses, and continues on yield", async () => {
		const setup = chatSetup();
		const requests: string[][] = [];
		const record: FauxResponseStep = (request) => {
			requests.push(request.messages.map((message) => `${message.role}:${textOf(message as never) ?? ""}`));
			return fauxAssistantMessage([fauxText(`answer ${requests.length}`)]);
		};
		addHooks(setup.registry, GenerationTask, {
			beforeRequest: ({ messages }) => ({
				messages: [...messages, { role: "user", content: "injected", timestamp: 0 }],
			}),
		});
		const responses: string[] = [];
		addHooks(setup.registry, GenerationTask, {
			afterResponse: (message) => void responses.push(textOf(message) ?? ""),
		});
		let yields = 0;
		addHooks(setup.registry, GenerationTask, {
			onYield: () => (yields++ === 0 ? { continue: [{ type: "text", text: "keep going" }] } : undefined),
		});
		const { harness, entries, status } = await run(setup, [record, record]);
		expect(status).toBe("done");
		expect(requests[0]!.slice(-2)).toEqual(["user:go", "user:injected"]);
		expect(responses).toEqual(["answer 1", "answer 2"]);
		expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant", "pi.user", "pi.assistant"]);
		// The injected message was used for the request only.
		expect(entries.some((entry) => textOf(entry.model?.[0]) === "injected")).toBe(false);
		await harness.close(context);
	});

	it("keeps the run's input open across an onYield continuation and answers it with the final answer", async () => {
		const setup = chatSetup();
		let yields = 0;
		let harness!: Harness;
		let input: SubmissionId | undefined;
		let statusAtSecondRequest: string | undefined;
		addHooks(setup.registry, GenerationTask, {
			onYield: () => (yields++ === 0 ? { continue: "again" } : undefined),
		});
		const second: FauxResponseStep = async () => {
			input = (await harness.snapshot(LiveDoc, 1 as never, context))!.run!.inputs[0];
			statusAtSecondRequest = (await (await harness.submission(input!, context))!.status(context)).status;
			return fauxAssistantMessage([fauxText("second")]);
		};
		const result = await run(setup, [fauxAssistantMessage([fauxText("first")]), second], async (opened) => {
			harness = opened;
		});
		expect(statusAtSecondRequest).toBe("placed");
		const answers = result.entries.filter((entry) => entry.kind === "pi.assistant");
		expect(await (await harness.submission(input!, context))!.status(context)).toMatchObject({
			status: "done",
			answer: answers[1]!.id,
		});
		await harness.close(context);
	});

	it("observes responses that arrive by polling a deferred request", async () => {
		const setup = chatSetup({ deferred: { pendingFetches: 1, pollAfterMs: 1 } });
		const observed: string[] = [];
		addHooks(setup.registry, GenerationTask, {
			afterResponse: (message) => void observed.push(`${message.stopReason}:${textOf(message) ?? ""}`),
		});
		setup.settings.stream = { deferred: true };
		const result = await run(setup, [fauxAssistantMessage([fauxText("late")])]);
		expect(result.status).toBe("done");
		// The still-deferred results are not terminal.
		expect(observed).toEqual(["stop:late"]);
		await result.harness.close(context);
	});

	it("lets the first onYield continuation win and reports throws without stopping later handlers", async () => {
		const setup = chatSetup();
		const called: string[] = [];
		addHooks(setup.registry, GenerationTask, {
			afterResponse: () => {
				called.push("throwing observer");
				throw new Error("observer failed");
			},
		});
		addHooks(setup.registry, GenerationTask, { afterResponse: () => void called.push("next observer") });
		let yields = 0;
		addHooks(setup.registry, GenerationTask, {
			onYield: () => (yields++ === 0 ? { continue: "first" } : undefined),
		});
		addHooks(setup.registry, GenerationTask, {
			onYield: () => {
				called.push("second onYield");
				return called.filter((name) => name === "second onYield").length === 1 ? { continue: "second" } : undefined;
			},
		});
		const { harness, entries } = await run(setup, [
			fauxAssistantMessage([fauxText("a")]),
			fauxAssistantMessage([fauxText("b")]),
			fauxAssistantMessage([fauxText("c")]),
		]);
		// The first continuation skips the second handler; on the next answer the second handler's continuation wins.
		const users = entries.filter((entry) => entry.kind === "pi.user").map((entry) => textOf(entry.model![0]));
		expect(users).toEqual(["go", "first", "second"]);
		expect(called.filter((name) => name === "second onYield")).toHaveLength(2);
		expect(called.filter((name) => name === "next observer")).toHaveLength(3);
		expect(setup.reports.map((error) => (error as Error).message)).toContain("observer failed");
		await harness.close(context);
	});

	it("keeps durable hook decisions in task memos", async () => {
		const setup = chatSetup();
		let asked = 0;
		addTool(
			setup.registry,
			tool("echo", async () => ({ content: [] })),
		);
		addHooks(setup.registry, ToolTask, {
			beforeTool: async (_call, api) => {
				asked++;
				const decision = await api.memo("approval:decision", "approved", context);
				expect(await api.memo("approval:decision", "denied", context)).toBe(decision);
				return undefined;
			},
		});
		const { harness } = await run(setup, [calls(["echo", {}, "c1"]), DONE]);
		expect(asked).toBe(1);
		await harness.close(context);
	});
});

describe("tool execution api", () => {
	it("builds the environment per call from the conversation's cwd and runs commits, memos, and child tasks", async () => {
		const setup = chatSetup();
		const child = defineTask<{ n: number }, { phase: "run" }, number>({
			name: "test.child",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (task, runtime, callContext) => {
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: task.input.n * 2 } }),
						callContext,
					);
				},
			},
			abort: async () => {},
		});
		addTask(setup.registry, child);
		const seen: unknown[] = [];
		const probe = tool("probe", async (_args, api) => {
			seen.push(api.env?.cwd);
			seen.push((await api.agent(context)).tools.map((each) => each.name));
			seen.push(api.registry.extension("tool:probe") !== undefined);
			const entry = await api.commit(async (tx) => {
				// The next call runs in the new directory: its environment is built when it executes.
				await configure(tx, api.conversationId, { cwd: "/" });
				return tx.appendEntry(api.conversationId, { kind: "test.note", data: api.callId });
			}, context);
			seen.push(entry.byTaskId === api.taskId);
			seen.push(await api.memo("m", 1, context), await api.memo("m", 2, context));
			const id = await api.createTask(child, { n: 21 }, { ownership: { kind: "conversation" } }, context);
			const done = await api.waitForTask(id, context);
			seen.push(done.state.outcome);
			return { content: [] };
		});
		addTool(setup.registry, probe);
		setup.faux.setResponses([calls(["probe", {}, "c1"], ["probe", {}, "c2"]), DONE]);
		setup.settings.toolExecution = "sequential";
		const targets: unknown[] = [];
		const { harness, root } = await openChat(new MemoryStorage(), setup, {
			env: ({ conversationId, cwd }) => {
				targets.push([conversationId, cwd]);
				return new NodeExecutionEnv({ cwd: cwd ?? "/tmp" });
			},
		});
		await root.configure({ cwd: "/tmp" }, context);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		const outcome = { status: "completed", result: 42 };
		const call = (cwd: string) => [cwd, ["probe"], true, true, 1, 1, outcome];
		expect(seen).toEqual([...call("/tmp"), ...call("/")]);
		expect(targets).toContainEqual([root.id, "/tmp"]);
		expect(targets).toContainEqual([root.id, "/"]);
		await harness.close(context);
	});

	it("answers a throwing environment with a tool_error result and reports it once while preparing", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("probe", async () => ({ content: [{ type: "text", text: "ran" }] })),
		);
		const { harness, entries } = await run(setup, [calls(["probe", {}, "c1"]), DONE], undefined, {
			env: () => {
				throw new Error("no sandbox");
			},
		});
		const [result] = results(entries);
		expect(result).toMatchObject({ isError: true });
		expect(resultText(result!)).toBe("<harness>\n[error] no sandbox\n</harness>");
		// Each preparation reports the failure and renders without an environment.
		expect(setup.reports.filter((error) => (error as Error).message === "no sandbox").length).toBe(2);
		await harness.close(context);
	});
});

describe("coding tools", () => {
	it("answers a failing command with its retained tail and diagnostics in order", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-durable-coding-"));
		try {
			const setup = chatSetup();
			addTool(setup.registry, createBashTool());
			const command = "i=1; while [ $i -le 3000 ]; do echo line-$i; i=$((i + 1)); done; exit 7";
			setup.faux.setResponses([calls(["bash", { command }, "b"]), DONE]);
			const env = new NodeExecutionEnv({ cwd: directory });
			const { harness, root } = await openChat(new MemoryStorage(), setup, { env });
			await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
			const entry = (await allEntries(root)).find((candidate) => ToolResultEntry.is(candidate))!;
			const [result] = results([entry]);
			expect(result!.isError).toBe(true);
			const text = resultText(result!);
			expect(text.startsWith("line-1001\n")).toBe(true);
			expect(ToolResultEntry.is(entry) && entry.data.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"full_output",
				"tool_error",
				"truncated",
			]);
			expect(text).toContain("line-3000\n|<harness>\n[info] Full output: ");
			expect(text).toContain(
				"\n[error] Command exited with code 7\n[warn] Output truncated to its end: 1000 lines, ",
			);
			await harness.close(context);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reads, edits, and runs a command in one run, then answers", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-durable-coding-"));
		try {
			writeFileSync(join(directory, "notes.txt"), "hello world\n");
			const setup = chatSetup();
			setup.registry.install(
				defineExtension({ name: "coding", tools: [createReadTool(), createEditTool(), createBashTool()] }),
			);
			setup.faux.setResponses([
				calls(["read", { path: "notes.txt" }, "r"]),
				calls(["edit", { path: "notes.txt", edits: [{ oldText: "world", newText: "durable" }] }, "e"]),
				calls(["bash", { command: "cat notes.txt" }, "b"]),
				DONE,
			]);
			const env = new NodeExecutionEnv({ cwd: directory });
			const { harness, root } = await openChat(new MemoryStorage(), setup, { env });
			const settled = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
			expect(settled.status).toBe("done");
			const entries = await allEntries(root);
			expect(results(entries).map((result) => [result.toolName, result.isError, resultText(result)])).toEqual([
				["read", false, "hello world\n"],
				["edit", false, "Successfully replaced 1 block(s) in notes.txt."],
				["bash", false, "hello durable\n"],
			]);
			expect(entries.at(-1)!.kind).toBe("pi.assistant");
			expect(readFileSync(join(directory, "notes.txt"), "utf8")).toBe("hello durable\n");
			await harness.close(context);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("tool progress and lifetime", () => {
	it("applies the default output limits", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("lines", async (_args, api) => {
				for (let index = 1; index <= 2500; index++) api.output(`${index}\n`);
				return {};
			}),
		);
		const { harness, entries } = await run(setup, [calls(["lines", {}, "c1"]), DONE]);
		const text = resultText(results(entries)[0]!);
		expect(text.startsWith("1\n2\n")).toBe(true);
		expect(
			text.endsWith(
				"\n2000\n|<harness>\n[warn] Output truncated to its beginning: 500 lines, 2500 bytes dropped\n</harness>",
			),
		).toBe(true);
		await harness.close(context);
	});

	it("sanitizes running output but keeps explicit result content as the tool returned it", async () => {
		const setup = chatSetup();
		let slotOutput: string | undefined;
		addTool(
			setup.registry,
			tool("noisy", async (_args, api) => {
				api.output("a\u0007b\r\n");
				await api.details({ ready: true }, context);
				slotOutput = (await api.snapshot(LiveDoc, api.conversationId, context))?.tools?.[0]?.output;
				return {};
			}),
		);
		addTool(
			setup.registry,
			tool("explicit", async () => ({ content: [{ type: "text", text: "c\u001bd" }] })),
		);
		const { harness, entries } = await run(setup, [calls(["noisy", {}, "c1"], ["explicit", {}, "c2"]), DONE]);
		expect(slotOutput).toBe("ab\n");
		const byId = new Map(results(entries).map((result) => [result.toolCallId, resultText(result)]));
		expect(byId.get("c1")).toBe("ab\n");
		expect(byId.get("c2")).toBe("c\u001bd");
		await harness.close(context);
	});

	it("drops control keys set to undefined instead of faulting", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("grow", async () => ({ content: [], control: { addTools: ["extra"], terminate: undefined } })),
		);
		const extra = tool("extra", async () => ({ content: [] }));
		addTool(setup.registry, extra);
		const { harness, root, status } = await run(setup, [calls(["grow", {}, "c1"]), DONE], (_harness, conversation) =>
			conversation.configure({ tools: { remove: [extra] } }, context),
		);
		expect(status).toBe("done");
		// addTools deletes the name from a stored `{ remove }` filter.
		expect((await harness.snapshot(AgentDoc, root.id, context))?.tools).toEqual({ remove: [] });
		await harness.close(context);
	});

	it("uses explicit null details instead of the last reported value", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			tool("null", async (_args, api) => {
				await api.details({ old: 1 }, context);
				return { content: [], details: null };
			}),
		);
		const { harness, entries } = await run(setup, [calls(["null", {}, "c1"]), DONE]);
		expect(results(entries)[0]!.details).toBeNull();
		await harness.close(context);
	});

	it("settles details() promises with coalesced progress commits and the terminal commit", async () => {
		const setup = chatSetup();
		const settled: string[] = [];
		addTool(
			setup.registry,
			tool("details", async (_args, api) => {
				// Three updates in one throttle window coalesce; the last is still pending when execute() returns.
				const first = api.details({ n: 1 }, context).then(() => settled.push("first"));
				const second = api.details({ n: 2 }, context).then(() => settled.push("second"));
				await first;
				void second;
				void api.details({ n: 3 }, context).then(() => settled.push("third"));
				return { content: [] };
			}),
		);
		const { harness, entries } = await run(setup, [calls(["details", {}, "c1"]), DONE]);
		expect(settled).toEqual(["first", "second", "third"]);
		expect(results(entries)[0]!.details).toEqual({ n: 3 });
		await harness.close(context);
	});

	it("finishes a call under the implementation it resolved when the tool is replaced mid-call", async () => {
		const setup = chatSetup();
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			release = resolve;
		});
		let finish!: () => void;
		const finished = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const v1 = tool("work", async () => {
			release();
			await finished;
			return { content: [{ type: "text", text: "v1" }] };
		});
		addTool(setup.registry, v1);
		setup.faux.setResponses([calls(["work", {}, "c1"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await started;
		// The same extension name replaces the old one in place.
		addTool(
			setup.registry,
			tool("work", async () => ({ content: [{ type: "text", text: "v2" }] })),
		);
		finish();
		await submission.wait(context);
		expect(resultText(results(await allEntries(root))[0]!)).toBe("v1");
		await harness.close(context);
	});

	it("uses a section and hook extension reloaded mid-run from the run's next request", async () => {
		const setup = chatSetup();
		const requests: string[] = [];
		const prompt = (version: string) =>
			defineExtension({
				name: "prompt",
				sections: [section("mode", () => version)],
				hooks: [hook(GenerationTask, { beforeRequest: () => void requests.push(version) })],
			});
		setup.registry.install(prompt("v1"));
		const running = deferred();
		const reloaded = deferred();
		addTool(
			setup.registry,
			tool("work", async () => {
				running.resolve();
				await reloaded.promise;
				return { content: [] };
			}),
		);
		setup.faux.setResponses([calls(["work", {}, "c1"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await running.promise;
		setup.registry.install(prompt("v2"));
		reloaded.resolve();
		await submission.wait(context);
		const sections = (await allEntries(root)).flatMap((entry) => {
			const message = entry.model?.[0];
			return message?.role === "system" && message.sections !== undefined ? [message.sections] : [];
		});
		expect(sections).toEqual([{ mode: "<mode>\nv1\n</mode>" }, { mode: "<mode>\nv2\n</mode>" }]);
		expect(requests).toEqual(["v1", "v2"]);
		await harness.close(context);
	});

	it("rejects invocation-bound waits and stops watches when the tool's invocation ends", async () => {
		const setup = chatSetup();
		const never = defineTask<Record<string, never>, { phase: "never" }, null>({
			name: "test.never",
			version: 1,
			initial: () => ({ phase: "never" }),
			phases: { never: async () => {} },
			abort: async () => {},
		});
		let wait!: Promise<unknown>;
		let watchClosed!: Promise<unknown>;
		addTool(
			setup.registry,
			tool("detach", async (_args, api) => {
				// The child's definition is not registered, so it stays pending.
				const child = await api.createTask(never, {}, { ownership: { kind: "conversation" } }, context);
				wait = api.waitForTask(child, context);
				wait.catch(() => {});
				const watch = await api.watchDoc(LiveDoc, api.conversationId, context);
				watchClosed = watch!.closed;
				return { content: [] };
			}),
		);
		const { harness } = await run(setup, [calls(["detach", {}, "c1"]), DONE]);
		await expect(wait).rejects.toThrow("invocation has ended");
		await watchClosed;
		await harness.close(context);
	});

	it("rejects details() still waiting when the call is aborted during afterTool", async () => {
		const setup = chatSetup();
		let pendingDetails!: Promise<void>;
		const inAfterTool = deferred();
		addTool(
			setup.registry,
			tool("slow", async (_args, api) => {
				api.output("first\n");
				// The output commit is in flight, so these details wait for the next throttle window.
				pendingDetails = api.details({ step: 1 }, context);
				pendingDetails.catch(() => {});
				return {};
			}),
		);
		addHooks(setup.registry, ToolTask, {
			afterTool: async (_call, _result, _api, callContext) => {
				inAfterTool.resolve();
				await aborted(callContext.abortSignal!);
				return undefined;
			},
		});
		setup.faux.setResponses([calls(["slow", {}, "c1"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await inAfterTool.promise;
		const taskId = (await harness.snapshot(LiveDoc, root.id, context))!.tools![0]!.taskId!;
		await harness.abortTask(taskId, context);
		await expect(pendingDetails).rejects.toBeDefined();
		await submission.wait(context);
		await harness.close(context);
	});

	it("answers an aborted tool with only its durable output, discarding buffered output", async () => {
		const setup = chatSetup();
		let reached!: () => void;
		const buffered = new Promise<void>((resolve) => {
			reached = resolve;
		});
		addTool(
			setup.registry,
			tool("slow", async (_args, api, callContext) => {
				api.output("durable\n");
				// The first output commits at once; this one waits for the next throttle window.
				await new Promise((resolve) => setTimeout(resolve, 20));
				api.output("buffered\n");
				reached();
				await new Promise((_, reject) =>
					callContext.abortSignal!.addEventListener("abort", () => reject(callContext.abortSignal!.reason)),
				);
				return {};
			}),
		);
		setup.faux.setResponses([calls(["slow", {}, "c1"]), DONE]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await buffered;
		const taskId = (await harness.snapshot(LiveDoc, root.id, context))!.tools![0]!.taskId!;
		await harness.abortTask(taskId, context);
		await submission.wait(context);
		expect(resultText(results(await allEntries(root))[0]!)).toBe(
			"durable\n|<harness>\n[error] Tool slow was aborted\n</harness>",
		);
		await harness.close(context);
	});
});
