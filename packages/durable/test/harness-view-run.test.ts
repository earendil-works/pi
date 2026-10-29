// What a renderer sees of a run through the conversation view: the transcript window and `pi.live`, every change a
// commit makes, rebuilt from operations alone. This replaced the event stream (`watchEvents`, #11327).
import { GCProfiler, getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { Draft } from "@earendil-works/chord";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
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
	type Conversation,
	type ConversationView,
	defineTool,
	type Harness,
	LiveDoc,
	type LiveState,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { type ChatSetup, chatSetup, openChat, textOf, waitFor } from "./chat-support.ts";
import { addTool } from "./harness-support.ts";
import { slotsOf, viewHistory } from "./live-support.ts";
import { context, documentValues, followCommits, onValue } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";

type Frame = { value: ConversationView; ops: readonly Op[] };

/**
 * Start a watch of `conversation` that records every call and, with `check`, checks that its operations turn the value
 * before it into its value. The frames are what a renderer that keeps up gets.
 */
async function listen(conversation: Conversation, check = true) {
	const watch = await conversation.watch(context);
	const frames: Frame[] = [];
	let replayed = watch.value;
	let mismatches = 0;
	watch.start(
		onValue(async ({ value, ops }) => {
			if (check) {
				replayed = applyImmutable(replayed, ops);
				if (JSON.stringify(replayed) !== JSON.stringify(value)) mismatches++;
			}
			frames.push({ value, ops });
		}),
	);
	return { watch, frames, mismatches: () => mismatches };
}

const liveOf = (view: ConversationView) => (view.docs["pi.live"] ?? {}) as LiveState;

async function drained(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function slow(): ChatSetup {
	return chatSetup({ tokensPerSecond: 400, tokenSize: { min: 1, max: 1 } });
}

/** Committed partials of the Harness's generations, one per commit that has one. */
function partialsOf(harness: Harness): AssistantMessage[] {
	const partials: AssistantMessage[] = [];
	followCommits(harness, (publication) => {
		for (const change of documentValues(publication)) {
			const message = (change.value as LiveState)?.generation?.message as AssistantMessage | undefined;
			if (change.record.kind === "pi.live" && message !== undefined) partials.push(message);
		}
	});
	return partials;
}

/** The distinct in-flight partials in `states`, in order. */
function partialsIn(states: readonly LiveState[]): AssistantMessage[] {
	const partials: AssistantMessage[] = [];
	for (const state of states) {
		const message = state.generation?.message as AssistantMessage | undefined;
		if (message !== undefined && message !== partials.at(-1)) partials.push(message);
	}
	return partials;
}

describe("a run as the conversation view shows it", () => {
	it("streams the answer as operations that rebuild every committed partial, then appends it", async () => {
		const setup = slow();
		const text = "streamed answer text ".repeat(20);
		setup.faux.setResponses([fauxAssistantMessage([fauxText(text)])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const partials = partialsOf(harness);
		const history = await viewHistory(harness, root.id);
		const { watch, mismatches } = await listen(root);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await submission.wait(context);
		await drained();
		history.detach();
		expect(mismatches()).toBe(0);
		const states = history.live();
		expect(partials.length).toBeGreaterThan(1);
		expect(partialsIn(states).map(textOf)).toEqual(partials.map(textOf));
		// The run shows from the input's commit until the commit that appends the answer and clears the partial.
		const started = states.findIndex((state) => state.run !== undefined);
		expect(states[started]!.run).toEqual({
			taskId: expect.any(Number),
			inputs: [submission.id],
			turns: 0,
			first: expect.any(Number),
		});
		expect(history.views[started]!.entries.at(-1)!.kind).toBe("pi.user");
		const ended = states.findIndex((state, index) => index > started && state.run === undefined);
		expect(states[ended]!.generation).toBeUndefined();
		expect(textOf(history.views[ended]!.entries.at(-1)!.model![0])).toBe(text);
		expect(states.at(-1)).toEqual({});
		await watch.stop();
		await harness.close(context);
	});

	it("shows a tool call's slot from pending through its running output to its result entry", async () => {
		const setup = chatSetup();
		const gate = deferred();
		addTool(
			setup.registry,
			defineTool({
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
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("print", { n: 1 }, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const history = await viewHistory(harness, root.id);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await waitFor(() => slotsOf(history.live(), "c1").at(-1)?.output === "one\ntwo\n");
		gate.resolve();
		await submission.wait(context);
		history.detach();
		const slots = slotsOf(history.live(), "c1");
		const listed = slots.findIndex((slot) => slot !== undefined);
		// Listed pending with the tool-calling answer, in the same commit.
		expect(slots[listed]).toEqual({ callId: "c1", name: "print", status: "pending", taskId: expect.any(Number) });
		expect(history.views[listed]!.entries.at(-1)!.kind).toBe("pi.assistant");
		const outputs = slots.flatMap((slot) => (slot?.status === "running" ? [slot.output ?? ""] : []));
		expect([...new Set(outputs)]).toEqual(["", "one\n", "one\ntwo\n"]);
		// Done with its result entry, appended in the same commit.
		const done = slots.findIndex((slot) => slot?.status === "done");
		expect(slots[done]).toEqual({
			callId: "c1",
			name: "print",
			status: "done",
			taskId: expect.any(Number),
			entry: history.views[done]!.entries.at(-1)!.id,
		});
		expect(history.views[done]!.entries.at(-1)!.model![0]).toMatchObject({ role: "toolResult", toolCallId: "c1" });
		// The run's two generations, the tool round and the answer, hand the run over.
		const runTasks = new Set(history.live().flatMap((state) => (state.run === undefined ? [] : [state.run.taskId])));
		expect(runTasks.size).toBe(2);
		await harness.close(context);
	});

	it("shows queued inputs in the inbox, a retry backoff, and the next run", async () => {
		const setup = chatSetup();
		const release = deferred();
		const held: FauxResponseStep = async (_request, options) => {
			await Promise.race([release.promise, aborted(options!.signal!)]);
			return fauxAssistantMessage([fauxText("first")]);
		};
		const error = fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" });
		setup.faux.setResponses([held, error, fauxAssistantMessage([fauxText("second")])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		setup.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
		const history = await viewHistory(harness, root.id);
		const first = await root.submit({ type: "input", content: "a" }, context);
		const followUp = await root.submit({ type: "input", content: "f" }, context);
		const inbox = (view: ConversationView) =>
			(view.docs["pi.inbox"] as { items: { id: number; mode: string }[] }).items;
		expect(inbox(history.views.at(-1)!)).toEqual([expect.objectContaining({ id: followUp.id, mode: "followUp" })]);
		release.resolve();
		await followUp.wait(context);
		history.detach();
		const states = history.live();
		expect(states.some((state) => state.generation?.retry?.error === "503 Service Unavailable")).toBe(true);
		const retried = states.findIndex((state) => state.generation?.retry !== undefined);
		expect(states.slice(retried).some((state) => state.generation?.attempt === 2)).toBe(true);
		const runs = states.flatMap((state, index) =>
			state.run !== undefined && state.run.inputs !== states[index - 1]?.run?.inputs ? [state.run.inputs] : [],
		);
		expect(runs.at(0)).toEqual([first.id]);
		expect(runs.at(-1)).toEqual([followUp.id]);
		expect(inbox(history.views.at(-1)!)).toEqual([]);
		await harness.close(context);
	});

	it("rebuilds every committed partial of thinking, text, and tool-call arguments from the view's operations", async () => {
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
		const views: ConversationView[] = [];
		const ops: Op[][] = [];
		const observation = await harness.observeConversation(
			root.id,
			{
				advance: (call) => {
					if (call.kind !== "value") return;
					views.push(call.value);
					ops.push([...call.ops]);
				},
				end: () => {},
			},
			context,
		);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		observation.detach();
		// Replaying the operations alone, from the observation's value, gives every committed partial.
		let replayed = observation.value;
		const rebuilt: unknown[] = [];
		for (const batch of ops) {
			replayed = applyImmutable(replayed, batch);
			const partial = liveOf(replayed).generation?.message;
			if (partial !== undefined && partial !== rebuilt.at(-1)) rebuilt.push(partial);
		}
		expect(replayed).toEqual(views.at(-1));
		expect(partials.length).toBeGreaterThan(2);
		expect(rebuilt.map((partial) => (partial as AssistantMessage).content)).toEqual(
			partials.map((partial) => partial.content),
		);
		// Growing text and thinking travel as appends.
		const appends = ops.flat().filter((op) => op[0] === "a" && op[1][2] === "generation");
		expect(appends.length).toBeGreaterThan(2);
		await harness.close(context);
	});

	it("rebuilds a sliding tail window from output trims and appends", async () => {
		const setup = chatSetup();
		const gate = deferred();
		addTool(
			setup.registry,
			defineTool({
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
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("tail", {}, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const outputs: string[] = [];
		followCommits(harness, (publication) => {
			for (const change of documentValues(publication)) {
				const output = (change.value as LiveState)?.tools?.[0]?.output;
				if (change.record.kind === "pi.live" && output !== undefined && output !== outputs.at(-1)) {
					outputs.push(output);
				}
			}
		});
		const { watch, frames, mismatches } = await listen(root);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await waitFor(() => outputs.at(-1)?.endsWith("line 5\n") === true);
		gate.resolve();
		await submission.wait(context);
		await drained();
		await watch.stop();
		expect(mismatches()).toBe(0);
		const shown: string[] = [];
		for (const frame of frames) {
			const output = liveOf(frame.value).tools?.[0]?.output;
			if (output !== undefined && output !== shown.at(-1)) shown.push(output);
		}
		expect(shown).toEqual(outputs);
		expect(frames.some((frame) => frame.ops.some((op) => op[0] === "t"))).toBe(true);
		await harness.close(context);
	});

	it("ends a run and starts the queued follow-up's in one value", async () => {
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
		const history = await viewHistory(harness, root.id);
		release.resolve();
		await followUp.wait(context);
		history.detach();
		const states = history.live();
		const boundary = states.findIndex((state) => state.run?.inputs[0] === followUp.id);
		expect(states[boundary - 1]!.run?.inputs).toEqual([input.id]);
		const before = history.views[boundary - 1]!;
		const after = history.views[boundary]!;
		const appended = after.entries.slice(before.entries.length);
		expect(appended.map((entry) => [entry.kind, textOf(entry.model?.[0])])).toEqual([
			["pi.assistant", "first"],
			["pi.user", "f"],
		]);
		expect((after.docs["pi.inbox"] as { items: unknown[] }).items).toEqual([]);
		await harness.close(context);
	});

	it("ends a call that never runs through its own task, and a tool aborted with its generation", async () => {
		const setup = chatSetup();
		addTool(
			setup.registry,
			defineTool({
				name: "wait",
				description: "Waits until aborted",
				parameters: Type.Object({}),
				execute: (_args, _api, callContext) => aborted(callContext.abortSignal!),
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("ghost", {}, { id: "c1" }), fauxToolCall("wait", {}, { id: "c2" })], {
				stopReason: "toolUse",
			}),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const history = await viewHistory(harness, root.id);
		const submission = await root.submit({ type: "input", content: "go" }, context);
		await waitFor(() => slotsOf(history.live(), "c2").some((slot) => slot?.status === "running"));
		// Aborting the generation aborts its round: the tool ends with its aborted result first (spec §8.5).
		await harness.abortTask((await harness.snapshot(LiveDoc, root.id, context))!.run!.taskId, context);
		await submission.wait(context);
		history.detach();
		const states = history.live();
		// #11043: the call not offered is listed pending with its task in the commit of its calling answer, and its task
		// ends it done with its result entry.
		const listed = slotsOf(states, "c1").findIndex((slot) => slot !== undefined);
		expect(slotsOf(states, "c1")[listed]).toMatchObject({ status: "pending", unoffered: true });
		expect(slotsOf(states, "c1")[listed]!.taskId).toBeDefined();
		expect(history.views[listed]!.entries.at(-1)!.kind).toBe("pi.assistant");
		const ended = slotsOf(states, "c1").findIndex((slot) => slot?.status === "done");
		expect(slotsOf(states, "c1")[ended]!.entry).toBe(history.views[ended]!.entries.at(-1)!.id);
		// The aborted tool ends with its result entry, then the run ends without an answer.
		const done = slotsOf(states, "c2").findIndex((slot) => slot?.status === "done");
		expect(slotsOf(states, "c2")[done]!.entry).toBe(history.views[done]!.entries.at(-1)!.id);
		expect(states.at(-1)!.runFailure).toMatchObject({ inputs: [submission.id], reason: "aborted" });
		await harness.close(context);
	});

	it("keeps a steer in the current run, shows nothing for other conversations, and appends a reset", async () => {
		const setup = chatSetup();
		const gate = deferred();
		addTool(
			setup.registry,
			defineTool({
				name: "hold",
				description: "Waits",
				parameters: Type.Object({}),
				execute: async () => {
					await gate.promise;
					return {};
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {}, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		const history = await viewHistory(harness, root.id);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await waitFor(() => slotsOf(history.live(), "c1").some((slot) => slot?.status === "running"));
		const steer = await root.submit({ type: "input", content: "s", whenBusy: "steer" }, context);
		const count = history.views.length;
		await other.commit((tx) => tx.appendEntry(other.id, { kind: "note" }), context);
		expect(history.views.length).toBe(count);
		gate.resolve();
		await input.wait(context);
		await root.reset(undefined, context);
		history.detach();
		const states = history.live();
		// One run: the steer joined it.
		const runs = new Set(states.flatMap((state) => (state.run === undefined ? [] : [state.run.inputs[0]])));
		expect([...runs]).toEqual([input.id]);
		expect(states.some((state) => state.run?.inputs.includes(steer.id))).toBe(true);
		// The reset is appended in place, with no run.
		expect(history.views.at(-1)!.entries.at(-1)!.kind).toBe("pi.reset");
		expect(states.at(-1)!.run).toBeUndefined();
		await harness.close(context);
	});

	it("converts the streamed partial into one aborted answer entry when the run is aborted", async () => {
		const setup = chatSetup({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } });
		setup.faux.setResponses([fauxAssistantMessage([fauxText("x".repeat(400))])]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const history = await viewHistory(harness, root.id);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await waitFor(() => history.live().some((state) => state.generation?.message !== undefined));
		const live = await harness.snapshot(LiveDoc, root.id, context);
		await harness.abortTask(live!.run!.taskId, context);
		await submission.wait(context);
		history.detach();
		const states = history.live();
		const ended = states.findIndex((state, index) => index > 0 && state.run === undefined);
		expect(states[ended - 1]!.generation?.message).toBeDefined();
		const appended = history.views[ended]!.entries.slice(history.views[ended - 1]!.entries.length);
		expect(appended.map((entry) => entry.kind)).toEqual(["pi.assistant"]);
		expect(appended[0]!.model![0]).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(states[ended]!.runFailure).toMatchObject({ reason: "aborted" });
		await harness.close(context);
	});

	it("applies later operations to an overflow replacement that holds an in-flight partial", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const partial = fauxAssistantMessage([fauxText("hel")]);
		const watch = await root.watch(context, { min: 1, max: 1 });
		const change = (edit: (live: Draft<LiveState>) => void) =>
			root.commit(async (tx) => edit(await tx.doc(LiveDoc, root.id)), context);
		await change((live) => {
			live.generation = { attempt: 1, message: JSON.parse(JSON.stringify(partial)) };
		});
		// Past 10,000 pending operations: an append, a splice, and a `before` per commit.
		for (let index = 0; index < 3400; index++) {
			await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		}
		const frames: Frame[] = [];
		watch.start(
			onValue(async ({ value, ops }) => {
				frames.push({ value, ops });
			}),
		);
		await drained();
		expect(frames[0]!.ops).toEqual([["r", frames[0]!.value]]);
		await change((live) => {
			(live.generation!.message!.content[0] as { text: string }).text += "lo";
		});
		await drained();
		const update = frames.at(-1)!;
		expect(update.ops).toEqual([["a", ["docs", "pi.live", "generation", "message", "content", 0, "text"], "lo"]]);
		const rebuilt = applyImmutable(frames[0]!.value, update.ops);
		expect(liveOf(rebuilt).generation?.message?.content).toEqual([{ type: "text", text: "hello" }]);
		await watch.stop();
		await harness.close(context);
	}, 30_000);
});

const gc = (() => {
	setFlagsFromString("--expose-gc");
	return runInNewContext("gc") as () => void;
})();

/** Bytes `run` allocates, counting what collections during it freed. */
async function allocatedBytes(run: () => Promise<void>): Promise<number> {
	gc();
	const profiler = new GCProfiler();
	profiler.start();
	const before = getHeapStatistics().used_heap_size;
	await run();
	const after = getHeapStatistics().used_heap_size;
	let freed = 0;
	for (const collection of profiler.stop().statistics) {
		freed += collection.beforeGC.heapStatistics.usedHeapSize - collection.afterGC.heapStatistics.usedHeapSize;
	}
	return after - before + freed;
}

/** Heap bytes in use after a full collection. */
async function heapInUse(): Promise<number> {
	for (let round = 0; round < 3; round++) {
		await drained();
		gc();
	}
	return getHeapStatistics().used_heap_size;
}

// #9265
describe("streamed partials", () => {
	it("streams a tool-call partial as appends at its argument paths", async () => {
		const setup = chatSetup({ tokensPerSecond: 500, tokenSize: { min: 1, max: 1 } });
		setup.settings.progress = { partialIntervalMs: 20, outputIntervalMs: 100 };
		const args = { path: "src/file.ts", content: "const a = 1;\n".repeat(150) };
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("missing", args, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const partials = partialsOf(harness);
		const ops: Op[] = [];
		const observation = await harness.observeConversation(
			root.id,
			{ advance: (call) => call.kind === "value" && ops.push(...call.ops), end: () => {} },
			context,
		);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		observation.detach();
		const MESSAGE = ["docs", "pi.live", "generation", "message"];
		// Operations on the in-flight message, with their paths relative to it.
		const onMessage = ops.flatMap((op) => {
			const path = op[0] === "r" ? [] : (op[1] as readonly (string | number)[]);
			return MESSAGE.every((segment, index) => path[index] === segment)
				? [{ kind: op[0], path: path.slice(MESSAGE.length) }]
				: [];
		});
		const argumentAppends = onMessage.filter((op) => op.kind === "a" && op.path[2] === "arguments");
		expect(argumentAppends.length).toBeGreaterThan(10);
		expect(argumentAppends.every((op) => ["path", "content"].includes(String(op.path.at(-1))))).toBe(true);
		// The call is set whole only when a member appears (at most once per argument); growing strings are appends.
		// With the raw argument text on the block, every commit resent the whole call.
		const blockSets = onMessage.filter((op) => op.kind !== "a" && op.path.length === 2);
		expect(blockSets.length).toBeLessThanOrEqual(2);
		// The committed partials carry only the parsed arguments, never the raw argument text.
		for (const partial of partials) {
			for (const block of partial.content) {
				expect(Object.keys(block).sort()).toEqual(["arguments", "id", "name", "type"]);
			}
		}
		await harness.close(context);
	});

	it("commits a growing text and tool call at a cost that follows the new text, not the string lengths", async () => {
		/** Bytes allocated while streaming one answer of `size` characters of text and as much tool-call content. */
		const stream = async (size: number) => {
			const setup = chatSetup({ tokensPerSecond: 64_000, tokenSize: { min: 64, max: 64 } });
			setup.settings.progress = { partialIntervalMs: 1, outputIntervalMs: 100 };
			// Keep `pi.live` cached between commits, as the default retention does. Evicted after each use (the suite's
			// evicting run), every commit replays the document's delta chain: a cost of eviction, not of appending.
			setup.settings.documentRetentionMs = 60_000;
			const text = 'streamed text with "quotes" and \\ escapes\n'.repeat(size / 40);
			setup.faux.setResponses([
				fauxAssistantMessage(
					[fauxText(text), fauxToolCall("missing", { path: "a.ts", content: text }, { id: "c1" })],
					{
						stopReason: "toolUse",
					},
				),
				fauxAssistantMessage([fauxText("done")]),
			]);
			const { harness, root } = await openChat(new MemoryStorage(), setup);
			let commits = 0;
			followCommits(harness, () => commits++);
			const bytes = await allocatedBytes(async () => {
				await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
			});
			await harness.close(context);
			return { bytes, commits };
		};
		const small = await stream(40_000);
		const large = await stream(400_000);
		expect(large.commits).toBeGreaterThan(small.commits * 5);
		// Per commit, the cost stays flat: comparing the whole strings on every commit made it grow with their length.
		expect(large.bytes / large.commits / (small.bytes / small.commits)).toBeLessThan(2);
	}, 60_000);

	it("keeps a watcher's memory proportional to a long streamed text and tool call, not to their commits", async () => {
		const setup = chatSetup({ tokensPerSecond: 16_000, tokenSize: { min: 16, max: 16 } });
		setup.settings.progress = { partialIntervalMs: 1, outputIntervalMs: 100 };
		const line = (index: number) => `line ${index}: some streamed source text with "quotes" and \\ escapes\n`;
		const text = Array.from({ length: 2_000 }, (_, index) => line(index)).join("");
		const content = Array.from({ length: 2_000 }, (_, index) => line(index)).join("");
		setup.faux.setResponses([
			fauxAssistantMessage([fauxText(text), fauxToolCall("missing", { path: "a.ts", content }, { id: "c1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const { watch, frames } = await listen(root, false);
		const before = await heapInUse();
		const submission = await root.submit({ type: "input", content: "go" }, context);
		const partialContent = async () =>
			(await harness.snapshot(LiveDoc, root.id, context))?.generation?.message?.content;
		const shown = async (index: number): Promise<number> => {
			const block = (await partialContent())?.[index];
			if (block?.type === "text") return block.text.length;
			return block?.type === "toolCall" ? String(block.arguments.content ?? "").length : 0;
		};
		const retained: number[] = [];
		// Measure while the text, then the tool call, is almost complete: the watcher's view holds the most then.
		await waitFor(async () => (await shown(0)) > text.length * 0.95, 30_000);
		retained.push((await heapInUse()) - before);
		await waitFor(async () => (await shown(1)) > content.length * 0.95, 30_000);
		retained.push((await heapInUse()) - before);
		await submission.wait(context);
		const commits = frames.length;
		expect(commits).toBeGreaterThan(500);
		// The two 140 KB strings, the watcher's recorded frames and the rest of the stream: about 3 MB. Sliced append ops
		// made the watcher's view hold a copy of the text per commit: well over 100 MB.
		for (const bytes of retained) expect(bytes).toBeLessThan(20_000_000);
		await watch.stop();
		await harness.close(context);
	}, 60_000);
});
