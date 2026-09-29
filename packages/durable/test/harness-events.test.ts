import type { Draft } from "@earendil-works/chord";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import {
	type AgentEvent,
	type AgentEventStream,
	type Conversation,
	ConversationConfig,
	type Harness,
	LiveDoc,
	type LiveState,
	MemoryStorage,
	type MessageChange,
	type SnapshotEvent,
	UsageDoc,
	watchEvents,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { type ChatSetup, chatSetup, openChat, textOf, waitFor } from "./chat-support.ts";
import { context, documentChanges } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";

/** Attach and start an event stream that records every delivered batch. */
async function listen(harness: Harness, conversation: Conversation) {
	const stream = await watchEvents(harness, conversation.id, context);
	const batches: AgentEvent[][] = [];
	stream.start(async (events) => {
		batches.push([...events]);
	});
	return { stream, batches, events: () => batches.flat() };
}

async function drained(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function slow(): ChatSetup {
	return chatSetup({ tokensPerSecond: 400, tokenSize: { min: 1, max: 1 } });
}

/** Rebuild the streamed text of block 0 from `message_start` and the text deltas that follow it. */
function streamedText(events: readonly AgentEvent[]): string {
	let text = "";
	for (const event of events) {
		if (event.type === "message_start" && event.message.role === "assistant") {
			const block = event.message.content[0];
			text = block?.type === "text" ? block.text : "";
		}
		if (event.type !== "message_update") continue;
		for (const change of event.changes) {
			if (change.type === "text_start" && change.contentIndex === 0 && change.block.type === "text") {
				text = change.block.text;
			}
			if (change.type === "text_delta" && change.contentIndex === 0) text += change.delta;
		}
	}
	return text;
}

type Mutable = { [key: string]: unknown };

/** Apply message changes to a copy of `message`, as an events-only consumer would. */
function applyChanges(message: AssistantMessage, changes: readonly MessageChange[]): AssistantMessage {
	let next = structuredClone(message);
	for (const change of changes) {
		if (change.type === "message") next = structuredClone(change.message);
		else if (change.type === "block") next.content[change.contentIndex] = structuredClone(change.block);
		else if (change.type.endsWith("_start") && "block" in change) {
			next.content.splice(change.contentIndex, 0, structuredClone(change.block));
		} else if (change.type === "text_delta" || change.type === "thinking_delta") {
			const block = next.content[change.contentIndex] as unknown as Mutable;
			const field = change.type === "text_delta" ? "text" : "thinking";
			block[field] = `${block[field] as string}${change.delta}`;
		} else if (change.type === "toolcall_delta") {
			let target = (next.content[change.contentIndex] as unknown as Mutable).arguments as Mutable;
			for (const segment of change.path.slice(0, -1)) target = target[segment] as Mutable;
			const last = change.path.at(-1)!;
			target[last] = `${target[last] as string}${change.delta}`;
		}
	}
	return next;
}

/** Committed partials of `conversation`'s generation, one per commit that has one. */
function partialsOf(harness: Harness): AssistantMessage[] {
	const partials: AssistantMessage[] = [];
	harness.subscribeCommits((publication) => {
		for (const change of documentChanges(publication)) {
			const message = (change.value as LiveState | null)?.generation?.message as AssistantMessage | undefined;
			if (change.record.kind === "pi.live" && message !== undefined) partials.push(message);
		}
	});
	return partials;
}

describe("agent events", () => {
	it("streams a run as lifecycle events and text deltas that rebuild the answer", async () => {
		const setup = slow();
		const text = "streamed answer text ".repeat(20);
		setup.faux.setResponses([fauxAssistantMessage([fauxText(text)])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const { stream, events } = await listen(harness, root);
		expect(stream.snapshot).toMatchObject({ type: "snapshot", entries: [], tools: [], inbox: [] });
		const partials: string[] = [];
		harness.subscribeCommits((publication) => {
			for (const change of documentChanges(publication)) {
				const message = (change.value as LiveState | null)?.generation?.message as AssistantMessage | undefined;
				if (change.record.kind === "pi.live" && message !== undefined) partials.push(textOf(message) ?? "");
			}
		});
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await submission.wait(context);
		await drained();
		const all = events();
		const types = all.map((event) => event.type).filter((type, index, list) => type !== list[index - 1]);
		expect(types).toEqual([
			"message_start",
			"message_end",
			"submission",
			"run_start",
			"turn_start",
			"message_start",
			"message_update",
			"message_end",
			"turn_end",
			"run_end",
			"submission",
			"usage_changed",
		]);
		expect(all.find((event) => event.type === "run_start")).toEqual({ type: "run_start", inputs: [submission.id] });
		// After each event, the rebuilt text equals the committed partial of that commit.
		const rebuilt = all.flatMap((event, index) =>
			(event.type === "message_start" && event.message.role === "assistant") || event.type === "message_update"
				? [streamedText(all.slice(0, index + 1))]
				: [],
		);
		expect(rebuilt).toEqual(partials);
		expect(partials.length).toBeGreaterThan(1);
		const end = all.filter((event) => event.type === "message_end").at(-1)!;
		expect(end.type === "message_end" && textOf(end.entry!.model![0])).toBe(text);
		await stream.stop();
		await harness.close(context);
	});

	it("reports tool start, output appends, and the result entry", async () => {
		const setup = chatSetup();
		const gate = deferred();
		setup.registry.tools.add({
			name: "print",
			description: "Prints",
			parameters: Type.Object({ n: Type.Number() }),
			execute: async (_args, api) => {
				api.output("one\n");
				await new Promise((resolve) => setTimeout(resolve, 150));
				api.output("two\n");
				await gate.promise;
				return {};
			},
		});
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("print", { n: 1 }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const { stream, events } = await listen(harness, root);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		// The output events rebuild the slot's retained window.
		const output = (): string => {
			let text = "";
			for (const event of events()) {
				if (event.type !== "tool_execution_update" || event.output === undefined) continue;
				if ("set" in event.output) text = event.output.set;
				else text = text.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
			}
			return text;
		};
		await waitFor(() => output() === "one\ntwo\n");
		gate.resolve();
		await submission.wait(context);
		await drained();
		const tool = events().filter((event) => event.type.startsWith("tool_execution"));
		expect(tool[0]).toEqual({ type: "tool_execution_start", toolCallId: "c1", toolName: "print", args: { n: 1 } });
		const end = tool.at(-1)!;
		expect(end).toMatchObject({ type: "tool_execution_end", toolCallId: "c1", entry: { kind: "pi.tool-result" } });
		// As in the coding agent, the tool ends directly before its result message.
		const all = events();
		const endIndex = all.indexOf(end);
		expect(all.slice(endIndex, endIndex + 3).map((event) => event.type)).toEqual([
			"tool_execution_end",
			"message_start",
			"message_end",
		]);
		expect(all[endIndex + 1]).toMatchObject({ message: { role: "toolResult", toolCallId: "c1" } });
		// Two turns: the tool round, and the answer.
		expect(events().filter((event) => event.type === "turn_start")).toHaveLength(2);
		expect(events().filter((event) => event.type === "turn_end")).toHaveLength(2);
		await stream.stop();
		await harness.close(context);
	});

	it("reports queued submissions, inbox changes, and retries", async () => {
		const setup = chatSetup();
		const release = deferred();
		const held: FauxResponseStep = async (_request, options) => {
			await Promise.race([release.promise, aborted(options!.signal!)]);
			return fauxAssistantMessage([fauxText("first")]);
		};
		const error = fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" });
		setup.faux.setResponses([held, error, fauxAssistantMessage([fauxText("second")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.setRetryPolicy({ enabled: true, maxRetries: 1, baseDelayMs: 1 }, context);
		const { stream, events } = await listen(harness, root);
		await root.submit({ type: "input", content: "a" }, context);
		const followUp = await root.submit({ type: "input", content: "f" }, context);
		await drained();
		expect(events().filter((event) => event.type === "inbox_update")).toEqual([
			{ type: "inbox_update", items: [{ id: followUp.id, mode: "followUp" }] },
		]);
		release.resolve();
		await followUp.wait(context);
		await drained();
		const types = events().map((event) => event.type);
		expect(types).toContain("auto_retry_start");
		expect(types).toContain("auto_retry_end");
		expect(types.filter((type) => type === "run_start")).toHaveLength(2);
		expect(
			events()
				.filter((event) => event.type === "submission")
				.map((event) => event.record.status),
		).toEqual(["placed", "queued", "done", "placed", "done"]);
		await stream.stop();
		await harness.close(context);
	});

	it("replaces undelivered batches with one snapshot after 100 pending batches", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const stream = await watchEvents(harness, root.id, context);
		for (let index = 0; index < 101; index++) {
			await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		}
		const batches: AgentEvent[][] = [];
		stream.start(async (events) => {
			batches.push([...events]);
		});
		await drained();
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(1);
		expect(batches[0]![0]).toMatchObject({ type: "snapshot" });
		expect((batches[0]![0] as Extract<AgentEvent, { type: "snapshot" }>).entries).toHaveLength(101);
		await stream.stop();
		await harness.close(context);
	});

	it("rebuilds every committed partial of thinking, text, and tool-call arguments from message changes", async () => {
		const setup = chatSetup({ tokensPerSecond: 150, tokenSize: { min: 1, max: 1 } });
		const message = fauxAssistantMessage(
			[
				fauxThinking("thinking about it ".repeat(10)),
				fauxText("some text ".repeat(10)),
				fauxToolCall("missing", { path: "a/long/path/".repeat(10), note: "x".repeat(60) }, { id: "c1" }),
			],
			{ stopReason: "toolUse" },
		);
		setup.faux.setResponses([message, fauxAssistantMessage([fauxText("done")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const partials = partialsOf(harness);
		const { stream, events } = await listen(harness, root);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		await drained();
		const rebuilt: AssistantMessage[] = [];
		let current: AssistantMessage | undefined;
		// The streamed tool-calling message, up to its end; the short final answer commits no partial.
		for (const event of events()) {
			if (event.type === "message_end" && event.entry?.kind === "pi.assistant") break;
			if (event.type === "message_start" && event.message.role === "assistant") current = event.message;
			else if (event.type === "message_update") current = applyChanges(current!, event.changes);
			else continue;
			rebuilt.push(current!);
		}
		expect(partials.length).toBeGreaterThan(2);
		expect(rebuilt.map((partial) => partial.content)).toEqual(partials.map((partial) => partial.content));
		const types = new Set(
			events()
				.flatMap((event) => (event.type === "message_update" ? event.changes : []))
				.map((c) => c.type),
		);
		expect(types.has("thinking_delta") || types.has("text_delta")).toBe(true);
		await stream.stop();
		await harness.close(context);
	});

	it("rebuilds a sliding tail window from output trims and appends", async () => {
		const setup = chatSetup();
		const gate = deferred();
		setup.registry.tools.add({
			name: "tail",
			description: "Prints lines",
			parameters: Type.Object({}),
			outputLimits: { maxLines: 3, retain: "tail" },
			execute: async (_args, api) => {
				for (let line = 0; line < 6; line++) {
					api.output(`line ${line}\n`);
					await new Promise((resolve) => setTimeout(resolve, 120));
				}
				await gate.promise;
				return {};
			},
		});
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("tail", {}, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const outputs: string[] = [];
		harness.subscribeCommits((publication) => {
			for (const change of documentChanges(publication)) {
				const output = (change.value as LiveState | null)?.tools?.[0]?.output;
				if (change.record.kind === "pi.live" && output !== undefined && output !== outputs.at(-1)) {
					outputs.push(output);
				}
			}
		});
		const { stream, events } = await listen(harness, root);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await waitFor(() => outputs.at(-1)?.endsWith("line 5\n") === true);
		gate.resolve();
		await submission.wait(context);
		await drained();
		const rebuilt: string[] = [];
		let text = "";
		for (const event of events()) {
			if (event.type !== "tool_execution_update" || event.output === undefined) continue;
			if ("set" in event.output) text = event.output.set;
			else text = text.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
			rebuilt.push(text);
		}
		expect(rebuilt).toEqual(outputs);
		expect(
			events().some((event) => event.type === "tool_execution_update" && "trimStart" in (event.output ?? {})),
		).toBe(true);
		await stream.stop();
		await harness.close(context);
	});

	it("emits one exact batch when a run ends and a queued follow-up starts the next", async () => {
		const setup = chatSetup();
		const release = deferred();
		const held: FauxResponseStep = async (_request, options) => {
			await Promise.race([release.promise, aborted(options!.signal!)]);
			return fauxAssistantMessage([fauxText("first")]);
		};
		setup.faux.setResponses([held, fauxAssistantMessage([fauxText("second")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		const followUp = await root.submit({ type: "input", content: "f" }, context);
		const { stream, batches } = await listen(harness, root);
		release.resolve();
		await followUp.wait(context);
		await drained();
		const boundary = batches.find((batch) => batch.some((event) => event.type === "run_end"))!;
		expect(boundary.map((event) => event.type)).toEqual([
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"run_end",
			"submission",
			"submission",
			"inbox_update",
			"usage_changed",
			"run_start",
			"turn_start",
		]);
		expect(boundary.filter((event) => event.type === "submission").map((event) => event.record.id)).toEqual([
			input.id,
			followUp.id,
		]);
		await stream.stop();
		await harness.close(context);
	});

	it("ends calls that never run and unfinished tools whose run ended", async () => {
		const setup = chatSetup();
		setup.registry.tools.add({
			name: "wait",
			description: "Waits until aborted",
			parameters: Type.Object({}),
			execute: (_args, _api, callContext) => aborted(callContext.abortSignal!),
		});
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("ghost", {}, { id: "c1" }), fauxToolCall("wait", {}, { id: "c2" })], {
				stopReason: "toolUse",
			}),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const { stream, events } = await listen(harness, root);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await waitFor(() => events().some((event) => event.type === "tool_execution_start"));
		// Aborting post-tools alone ends the run while the tool still runs (spec §12).
		await harness.abortTask((await harness.snapshot(LiveDoc, root.id, context))!.run!.taskId, context);
		await submission.wait(context);
		await drained();
		// The call not offered ends after its calling message and directly before its result message.
		const round = events().map((event) =>
			event.type === "message_end"
				? `end:${event.entry.kind}`
				: event.type === "message_start"
					? `start:${event.message.role}`
					: event.type,
		);
		const ghostEnd = round.indexOf("tool_execution_end");
		expect(round.slice(ghostEnd - 1, ghostEnd + 3)).toEqual([
			"end:pi.assistant",
			"tool_execution_end",
			"start:toolResult",
			"end:pi.tool-result",
		]);
		const tool = events().filter((event) => event.type.startsWith("tool_execution"));
		expect(tool.map((event) => [event.type, "toolCallId" in event && event.toolCallId, "entry" in event])).toEqual([
			["tool_execution_end", "c1", true],
			["tool_execution_start", "c2", false],
			["tool_execution_end", "c2", false],
		]);
		await stream.stop();
		await harness.close(context);
	});

	it("reports a steer without run events, a reset as an appended entry, and nothing for other conversations", async () => {
		const setup = chatSetup();
		const gate = deferred();
		setup.registry.tools.add({
			name: "hold",
			description: "Waits",
			parameters: Type.Object({}),
			execute: async () => {
				await gate.promise;
				return {};
			},
		});
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {}, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const { stream, events, batches } = await listen(harness, root);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await waitFor(() => events().some((event) => event.type === "tool_execution_start"));
		await root.submit({ type: "input", content: "s", whenBusy: "steer" }, context);
		const before = batches.length;
		await other.commit((tx) => tx.appendEntry(other.id, { kind: "note" }), context);
		await drained();
		expect(batches.length).toBe(before);
		gate.resolve();
		await input.wait(context);
		await root.reset(undefined, context);
		await drained();
		expect(events().filter((event) => event.type === "run_start")).toHaveLength(1);
		expect(events().filter((event) => event.type === "run_end")).toHaveLength(1);
		expect(batches.at(-1)!.map((event) => event.type)).toEqual(["entry_appended", "submission"]);
		await stream.stop();
		await harness.close(context);
	});

	it("rejects an attachment cancelled while it waits for the Session line", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const release = deferred();
		const blocking = root.commit(async () => {
			await release.promise;
		}, context);
		const controller = new AbortController();
		const attaching = watchEvents(harness, root.id, { ...context, abortSignal: controller.signal });
		controller.abort(new Error("cancelled"));
		release.resolve();
		await blocking;
		await expect(attaching).rejects.toThrow("cancelled");
		await harness.close(context);
	});

	it("applies deltas after an overflow snapshot that holds an in-flight partial", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const partial = fauxAssistantMessage([fauxText("hel")]);
		const stream = await watchEvents(harness, root.id, context);
		await root.commit(async (tx) => {
			(await tx.doc(LiveDoc, root.id)).generation = {
				attempt: 1,
				message: JSON.parse(JSON.stringify(partial)),
			};
		}, context);
		for (let index = 0; index < 101; index++) {
			await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		}
		const batches: AgentEvent[][] = [];
		stream.start(async (events) => {
			batches.push([...events]);
		});
		await drained();
		const snapshot = batches[0]![0] as SnapshotEvent;
		expect(snapshot.type).toBe("snapshot");
		await root.commit(async (tx) => {
			const block = (await tx.doc(LiveDoc, root.id)).generation!.message!.content[0] as { text: string };
			block.text += "lo";
		}, context);
		await drained();
		const update = batches.at(-1)![0]!;
		if (update.type !== "message_update") throw new Error(`Unexpected ${update.type}`);
		expect(update.changes).toEqual([{ type: "text_delta", contentIndex: 0, delta: "lo" }]);
		const rebuilt = applyChanges(snapshot.generation!.message!, update.changes);
		expect(rebuilt.content).toEqual([{ type: "text", text: "hello" }]);
		await stream.stop();
		await harness.close(context);
	});

	it("reports usage-only updates, cleared tool progress, tools ending without entries, and deferred polls", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const { stream, batches } = await listen(harness, root);
		const change = (edit: (live: Draft<LiveState>) => void) =>
			root.commit(async (tx) => edit(await tx.doc(LiveDoc, root.id)), context);
		const partial = JSON.parse(JSON.stringify(fauxAssistantMessage([fauxText("partial")])));
		await change((live) => {
			live.generation = { attempt: 1, message: partial };
		});
		// A usage-only change sends the usage and no changes.
		await change((live) => {
			live.generation!.message!.usage.input = 42;
		});
		await change((live) => {
			live.generation = { attempt: 1, deferred: { pollAt: 1 } };
		});
		await change((live) => {
			live.generation!.deferred!.pollAt = 2;
		});
		await change((live) => {
			live.tools = [{ callId: "c1", name: "t", status: "running", details: { n: 1 }, diagnostics: [] }];
		});
		// A safe replay clears the running slot's progress.
		await change((live) => {
			delete live.tools![0]!.details;
			delete live.tools![0]!.diagnostics;
		});
		// A fault marks the slot done without an entry.
		await change((live) => {
			live.tools![0]!.status = "done";
		});
		await root.commit((tx) => tx.retireDoc(UsageDoc, root.id), context);
		await root.commit((tx) => tx.retireDoc(ConversationConfig, root.id), context);
		await drained();
		expect(batches.map((batch) => batch.filter((event) => event.type !== "task_failed"))).toEqual([
			[{ type: "message_start", message: partial }],
			[{ type: "message_update", usage: { ...partial.usage, input: 42 }, changes: [] }],
			[{ type: "deferred_poll", pollAt: 1 }],
			[{ type: "deferred_poll", pollAt: 2 }],
			[{ type: "tool_execution_start", toolCallId: "c1", toolName: "t", args: {} }],
			[{ type: "tool_execution_update", toolCallId: "c1", toolName: "t", details: null, diagnostics: [] }],
			[{ type: "tool_execution_end", toolCallId: "c1", toolName: "t" }],
			// Retired documents read as their initial values.
			[{ type: "usage_changed", usage: { models: {}, tools: {} } }],
			[{ type: "config_changed", config: { thinkingLevel: "off", activeTools: [] } }],
		]);
		await stream.stop();
		await harness.close(context);
	});

	it("ends the stream with the Harness", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const stream: AgentEventStream = await watchEvents(harness, root.id, context);
		await harness.close(context);
		expect(await stream.closed).toEqual({ reason: "session_closed" });
	});

	it("starts a message at the first committed partial and ends it with the converted entry on abort", async () => {
		const setup = chatSetup({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } });
		setup.faux.setResponses([fauxAssistantMessage([fauxText("x".repeat(400))])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const { stream, events } = await listen(harness, root);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await waitFor(() =>
			events().some((event) => event.type === "message_start" && event.message.role === "assistant"),
		);
		const live = await harness.snapshot(LiveDoc, root.id, context);
		await harness.abortTask(live!.run!.taskId, context);
		await submission.wait(context);
		await drained();
		const assistantEnds = events().filter(
			(event) => event.type === "message_end" && event.entry?.kind === "pi.assistant",
		);
		expect(assistantEnds).toHaveLength(1);
		expect(
			events().filter((event) => event.type === "message_start" && event.message.role === "assistant"),
		).toHaveLength(1);
		await stream.stop();
		await harness.close(context);
	});
});
