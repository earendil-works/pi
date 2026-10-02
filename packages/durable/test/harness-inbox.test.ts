import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "@earendil-works/chord/delta";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type ToolResultMessage,
	Type,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	type Conversation,
	defineDoc,
	defineTool,
	type EntryRecord,
	GenerationTask,
	type Harness,
	InboxDoc,
	type InboxState,
	LiveDoc,
	MemoryStorage,
	ResetEntry,
	type Submission,
	type SubmissionRecord,
	type ToolExecutionResult,
	ToolTask,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { recordUsage } from "../src/harness/usage.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf, waitFor } from "./chat-support.ts";
import { addHooks, addTool } from "./harness-support.ts";
import { ControlledStorage, context, documentChanges, flush } from "./session-support.ts";
import { aborted, type Deferred, deferred } from "./task-support.ts";

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

function answer(text: string): AssistantMessage {
	return fauxAssistantMessage([fauxText(text)]);
}

/** A faux response held until `release` or cancellation; `reached` resolves when the request is sent. */
function gated(message: AssistantMessage): { step: FauxResponseStep; reached: Promise<void>; release: () => void } {
	const reached = deferred();
	const gate = deferred();
	const step: FauxResponseStep = async (_request, options) => {
		reached.resolve();
		await Promise.race([gate.promise, aborted(options!.signal!)]);
		return message;
	};
	return { step, reached: reached.promise, release: () => gate.resolve() };
}

/** Register a `hold` tool whose calls wait for `gate` and then return `result`. */
function holdTool(setup: ChatSetup, gate: Deferred, result: ToolExecutionResult = { content: [] }): void {
	addTool(
		setup.registry,
		defineTool({
			name: "hold",
			description: "Waits for the test",
			parameters: Type.Object({}),
			execute: async () => {
				await gate.promise;
				return result;
			},
		}),
	);
}

const HOLD = fauxAssistantMessage([fauxToolCall("hold", {}, { id: "c1" })], { stopReason: "toolUse" });

async function status(submission: Submission): Promise<SubmissionRecord> {
	return submission.status(context);
}

/** Kind and text of each entry, skipping system entries. */
function transcript(entries: readonly EntryRecord[]): string[] {
	return entries
		.filter((entry) => entry.kind !== "pi.system")
		.map((entry) => {
			const message = entry.model?.[0];
			const text = message?.role === "toolResult" ? undefined : textOf(message);
			return text === undefined ? entry.kind : `${entry.kind}:${text}`;
		});
}

async function inbox(harness: Harness, root: Conversation) {
	return (await harness.snapshot(InboxDoc, root.id, context))!.items.map((item) => [item.id, item.mode]);
}

async function toolRunning(harness: Harness, root: Conversation): Promise<void> {
	await waitFor(async () => (await harness.snapshot(LiveDoc, root.id, context))?.tools?.[0]?.status === "running");
}

describe("inbox", () => {
	it("queues busy submissions and places writes before user items at the final boundary, one follow-up per run", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step, answer("second"), answer("third")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const f1 = await root.submit({ type: "input", content: "f1" }, context);
		const write = await root.submit({ type: "write", entry: { kind: "note", data: "w" } }, context);
		const f2 = await root.submit({ type: "input", content: "f2", whenBusy: "followUp" }, context);
		for (const submission of [f1, write, f2]) expect((await status(submission)).status).toBe("queued");
		expect(await inbox(harness, root)).toEqual([
			[f1.id, "followUp"],
			[write.id, "write"],
			[f2.id, "followUp"],
		]);
		expect(transcript(await allEntries(root))).toEqual(["pi.user:a"]);

		first.release();
		await f2.wait(context);
		expect(transcript(await allEntries(root))).toEqual([
			"pi.user:a",
			"pi.assistant:first",
			"note",
			"pi.user:f1",
			"pi.assistant:second",
			"pi.user:f2",
			"pi.assistant:third",
		]);
		const answers = (await allEntries(root)).filter((entry) => entry.kind === "pi.assistant");
		expect(await status(input)).toMatchObject({ status: "done", answer: answers[0]!.id });
		expect(await status(write)).toMatchObject({ status: "done" });
		expect(await status(f1)).toMatchObject({ status: "done", answer: answers[1]!.id });
		expect(await status(f2)).toMatchObject({ status: "done", answer: answers[2]!.id });
		expect(await inbox(harness, root)).toEqual([]);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		await harness.close(context);
	});

	it("places every follow-up in one successor run with followUpMode all", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step, answer("both")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		setup.settings.followUpMode = "all";
		await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const f1 = await root.submit({ type: "input", content: "f1" }, context);
		const f2 = await root.submit({ type: "input", content: "f2" }, context);
		first.release();
		const settled = await f2.wait(context);
		expect(await status(f1)).toEqual({ ...settled, id: f1.id, entry: expect.any(Number) });
		expect(transcript(await allEntries(root))).toEqual([
			"pi.user:a",
			"pi.assistant:first",
			"pi.user:f1",
			"pi.user:f2",
			"pi.assistant:both",
		]);
		expect(setup.faux.state.callCount).toBe(2);
		await harness.close(context);
	});

	it("reads queue modes when the final boundary's commit runs on the Session line", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step, answer("both")]);
		const yielded = deferred();
		addHooks(setup.registry, GenerationTask, { onYield: () => void yielded.resolve() });
		const storage = new ControlledStorage();
		const { harness, root } = await openChat(storage, setup);
		await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const f1 = await root.submit({ type: "input", content: "f1" }, context);
		const f2 = await root.submit({ type: "input", content: "f2" }, context);
		// Occupy the line, let the answer queue its boundary commit behind it, then change the mode.
		const held = storage.holdCommits();
		const Marker = defineDoc<{ n: number }>({
			kind: "test.marker",
			version: 1,
			scope: "session",
			initial: () => ({ n: 0 }),
		});
		const occupying = root.commit(async (tx) => void (await tx.doc(Marker)).n++, context);
		await held.entered;
		first.release();
		await yielded.promise;
		await flush();
		setup.settings.followUpMode = "all";
		held.release();
		await occupying;
		const settled = await f2.wait(context);
		expect(await status(f1)).toEqual({ ...settled, id: f1.id, entry: expect.any(Number) });
		expect(setup.faux.state.callCount).toBe(2);
		await harness.close(context);
	});

	it("adds steers to the run at the postTools boundary and holds follow-ups for the final boundary", async () => {
		const setup = chatSetup();
		const gate = deferred();
		holdTool(setup, gate);
		setup.faux.setResponses([HOLD, answer("after tools"), answer("follow-up")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await toolRunning(harness, root);
		const steer = await root.submit({ type: "input", content: "s", whenBusy: "steer" }, context);
		const followUp = await root.submit({ type: "input", content: "f" }, context);
		gate.resolve();
		await followUp.wait(context);
		expect(transcript(await allEntries(root))).toEqual([
			"pi.user:a",
			"pi.assistant",
			"pi.tool-result",
			"pi.user:s",
			"pi.assistant:after tools",
			"pi.user:f",
			"pi.assistant:follow-up",
		]);
		const answers = (await allEntries(root)).filter((entry) => entry.kind === "pi.assistant");
		expect(await status(input)).toMatchObject({ status: "done", answer: answers[1]!.id });
		expect(await status(steer)).toMatchObject({ status: "done", answer: answers[1]!.id });
		expect(await status(followUp)).toMatchObject({ status: "done", answer: answers[2]!.id });
		await harness.close(context);
	});

	it("ends the run at a queued reset after tools and runs earlier follow-ups in the new context", async () => {
		const setup = chatSetup();
		const gate = deferred();
		holdTool(setup, gate);
		const requests: string[][] = [];
		const record: FauxResponseStep = (request) => {
			requests.push(request.messages.map((message) => `${message.role}:${textOf(message) ?? ""}`));
			return answer("fresh");
		};
		setup.faux.setResponses([HOLD, record]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await toolRunning(harness, root);
		const followUp = await root.submit({ type: "input", content: "f" }, context);
		await root.reset(undefined, context);
		gate.resolve();
		await followUp.wait(context);
		expect(await status(input)).toMatchObject({ status: "unanswered", reason: "reset" });
		expect(transcript(await allEntries(root))).toEqual([
			"pi.user:a",
			"pi.assistant",
			"pi.tool-result",
			"pi.reset",
			"pi.user:f",
			"pi.assistant:fresh",
		]);
		const reset = (await allEntries(root)).find((entry) => ResetEntry.is(entry))!;
		expect(reset.head).toBe(reset.id);
		// The follow-up's request starts at the reset: the follow-up, then the complete system baseline after the cut.
		expect(requests).toEqual([["user:f", "system:"]]);
		expect(setup.faux.state.callCount).toBe(2);
		await harness.close(context);
	});

	it("places a queued reset after the answer at the final boundary", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		await root.reset("handoff", context);
		first.release();
		await input.wait(context);
		await harness.waitForIdle(context);
		expect(await status(input)).toMatchObject({ status: "done" });
		expect(transcript(await allEntries(root))).toEqual(["pi.user:a", "pi.assistant:first", "pi.reset:handoff"]);
		expect((await root.context(context)).messages).toEqual([
			{ role: "user", content: "handoff", timestamp: expect.any(Number) },
		]);
		await harness.close(context);
	});

	it("resets an idle conversation at once, with or without handoff text", async () => {
		const setup = chatSetup();
		setup.now = () => 7;
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		await root.reset(undefined, context);
		let view = await root.context(context);
		expect(view.head?.kind).toBe("pi.reset");
		expect(view.head?.model).toBeUndefined();
		expect(view.messages).toEqual([]);
		await root.reset("carry on", context);
		view = await root.context(context);
		expect(view.head?.head).toBe(view.head?.id);
		expect(view.messages).toEqual([{ role: "user", content: "carry on", timestamp: 7 }]);
		await harness.close(context);
	});

	it("makes a queued head write stale when it targets an entry before the active range", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step, answer("second")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const old = await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		await root.reset(undefined, context);
		const reset = (await root.context(context)).head!;
		const input = await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const stale = await root.submit({ type: "write", entry: { kind: "summary", head: old.id } }, context);
		const fresh = await root.submit({ type: "write", entry: { kind: "summary", head: reset.id } }, context);
		first.release();
		await input.wait(context);
		expect(await status(stale)).toMatchObject({ status: "unanswered", reason: "stale" });
		expect(await status(fresh)).toMatchObject({ status: "done" });
		expect(await inbox(harness, root)).toEqual([]);

		// The fresh summary's marker starts the range at the reset: a target inside the range is not stale, even when
		// it is older than the marker itself. A reset placed earlier in the same boundary makes it stale.
		const inside = (await allEntries(root)).find((entry) => entry.kind === "pi.user")!;
		const second = await root.submit({ type: "input", content: "b" }, context);
		const kept = await root.submit({ type: "write", entry: { kind: "summary", head: inside.id } }, context);
		await second.wait(context);
		expect(await status(kept)).toMatchObject({ status: "done" });
		await harness.close(context);
	});

	it("makes a head write stale behind a reset placed earlier in the same boundary", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const target = (await allEntries(root))[0]!;
		await root.reset(undefined, context);
		const summary = await root.submit({ type: "write", entry: { kind: "summary", head: target.id } }, context);
		first.release();
		await input.wait(context);
		expect(await status(summary)).toMatchObject({ status: "unanswered", reason: "stale" });
		await harness.close(context);
	});

	it("ends the run with a pi.reset entry when a tool requests a handoff", async () => {
		const setup = chatSetup();
		const gate = deferred();
		gate.resolve();
		holdTool(setup, gate, { content: [], control: { handoff: "continue here" } });
		setup.faux.setResponses([HOLD]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const settled = await (await root.submit({ type: "input", content: "a" }, context)).wait(context);
		const entries = await allEntries(root);
		const calling = entries.find((entry) => entry.kind === "pi.assistant")!;
		expect(settled).toMatchObject({ status: "done", answer: calling.id });
		expect(transcript(entries)).toEqual(["pi.user:a", "pi.assistant", "pi.tool-result", "pi.reset:continue here"]);
		expect(entries.at(-1)!.head).toBe(entries.at(-1)!.id);
		expect(setup.faux.state.callCount).toBe(1);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		await harness.close(context);
	});

	it("drops an onYield continuation when the final boundary selects a follow-up", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step, answer("second")]);
		let yields = 0;
		addHooks(setup.registry, GenerationTask, { onYield: () => (yields++ === 0 ? { continue: "more" } : undefined) });
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const followUp = await root.submit({ type: "input", content: "f" }, context);
		first.release();
		await followUp.wait(context);
		expect(await status(input)).toMatchObject({ status: "done" });
		expect(transcript(await allEntries(root))).toEqual([
			"pi.user:a",
			"pi.assistant:first",
			"pi.user:f",
			"pi.assistant:second",
		]);
		await harness.close(context);
	});

	it("withdraws a queued submission and removes its item", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const kept = await root.submit({ type: "write", entry: { kind: "note" } }, context);
		const withdrawn = await root.submit({ type: "input", content: "f" }, context);
		expect(await withdrawn.abort(context)).toBe("aborted");
		expect(await withdrawn.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(await inbox(harness, root)).toEqual([[kept.id, "write"]]);
		first.release();
		await input.wait(context);
		expect(await status(kept)).toMatchObject({ status: "done" });
		expect(setup.faux.state.callCount).toBe(1);
		await harness.close(context);
	});

	it("leaves queued items after a failed run until the next submission places them in order", async () => {
		const setup = chatSetup();
		const failing = gated(fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid request" }));
		setup.faux.setResponses([failing.step, answer("for f"), answer("for g")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await failing.reached;
		const f = await root.submit({ type: "input", content: "f" }, context);
		failing.release();
		expect(await input.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
		await harness.waitForIdle(context);
		expect((await status(f)).status).toBe("queued");
		expect(await inbox(harness, root)).toEqual([[f.id, "followUp"]]);

		// Idle with a queued item: the new input queues behind it, and a final boundary places the older one first.
		const g = await root.submit({ type: "input", content: "g", whenBusy: "reject" }, context);
		await g.wait(context);
		expect(await status(f)).toMatchObject({ status: "done" });
		expect(transcript(await allEntries(root)).slice(-4)).toEqual([
			"pi.user:f",
			"pi.assistant:for f",
			"pi.user:g",
			"pi.assistant:for g",
		]);
		await harness.close(context);
	});

	it("keeps queued submissions across reopen and settles them afterwards", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-inbox-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step, answer("first again"), answer("f")]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		await opened.root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const f = (await opened.root.submit({ type: "input", content: "f" }, context)).id;
		await opened.harness.close(context);

		opened = await openChat(await openNodeSqliteStorage(path), setup);
		const settled = await (await opened.harness.submission(f, context))!.wait(context);
		expect(settled).toMatchObject({ status: "done" });
		expect(transcript(await allEntries(opened.root)).slice(-2)).toEqual(["pi.user:f", "pi.assistant:f"]);
		await opened.harness.close(context);
	});

	it("commits inbox changes as positional Chord operations and a base when empty", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step, answer("second")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const ops: Op[][] = [];
		harness.subscribeCommits((publication) => {
			for (const change of documentChanges(publication)) {
				if (change.record.kind === "pi.inbox" && change.ops.length > 0) ops.push([...change.ops]);
			}
		});
		const input = await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const w1 = await root.submit({ type: "write", entry: { kind: "note" } }, context);
		const f1 = await root.submit({ type: "input", content: "f1" }, context);
		const w2 = await root.submit({ type: "write", entry: { kind: "note" } }, context);
		const f2 = await root.submit({ type: "input", content: "f2" }, context);
		const w3 = await root.submit({ type: "write", entry: { kind: "note" } }, context);
		expect(ops).toEqual([
			[["p", ["items"], 0, 0, [{ id: w1.id, mode: "write", entry: { kind: "note" } }]]],
			[["p", ["items"], 1, 0, [{ id: f1.id, mode: "followUp", content: "f1" }]]],
			[["p", ["items"], 2, 0, [{ id: w2.id, mode: "write", entry: { kind: "note" } }]]],
			[["p", ["items"], 3, 0, [{ id: f2.id, mode: "followUp", content: "f2" }]]],
			[["p", ["items"], 4, 0, [{ id: w3.id, mode: "write", entry: { kind: "note" } }]]],
		]);
		first.release();
		await input.wait(context);
		// Every write and the first follow-up leave; only f2 at index 3 remains. No retained value is carried.
		expect(ops[5]!.every((op) => op[0] === "p" && (op[4] as unknown[]).length === 0)).toBe(true);
		expect(ops[5]).toContainEqual(["p", ["items"], 4, 1, []]);
		expect(JSON.stringify(ops[5])).not.toContain("f2");
		await f2.wait(context);
		await harness.close(context);
	});

	it("settles a stale write at once while idle, and a queued one behind waiting items", async () => {
		const setup = chatSetup();
		const failing = gated(fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid request" }));
		setup.faux.setResponses([failing.step, answer("for f")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const old = await root.commit((tx) => tx.appendEntry(root.id, { kind: "note" }), context);
		await root.reset(undefined, context);
		const before = (await allEntries(root)).length;
		const idle = await root.submit({ type: "write", entry: { kind: "summary", head: old.id } }, context);
		expect(await idle.wait(context)).toMatchObject({ status: "unanswered", reason: "stale" });
		expect(await allEntries(root)).toHaveLength(before);

		// After a failed run, a follow-up waits; a stale write queues behind it and the boundary rejects it.
		const input = await root.submit({ type: "input", content: "a" }, context);
		await failing.reached;
		const f = await root.submit({ type: "input", content: "f" }, context);
		failing.release();
		await input.wait(context);
		await harness.waitForIdle(context);
		const queued = await root.submit({ type: "write", entry: { kind: "summary", head: old.id } }, context);
		expect(await queued.wait(context)).toMatchObject({ status: "unanswered", reason: "stale" });
		expect(await f.wait(context)).toMatchObject({ status: "done" });
		await harness.close(context);
	});

	it("keeps an onYield continuation across a queued plain write, with the run's original input", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step, answer("second")]);
		let yields = 0;
		addHooks(setup.registry, GenerationTask, { onYield: () => (yields++ === 0 ? { continue: "more" } : undefined) });
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const write = await root.submit({ type: "write", entry: { kind: "note" } }, context);
		first.release();
		await input.wait(context);
		const entries = await allEntries(root);
		expect(transcript(entries)).toEqual([
			"pi.user:a",
			"pi.assistant:first",
			"note",
			"pi.user:more",
			"pi.assistant:second",
		]);
		expect(await status(input)).toMatchObject({ status: "done", answer: entries.at(-1)!.id });
		expect(await status(write)).toMatchObject({ status: "done" });
		await harness.close(context);
	});

	it("drops an onYield continuation for a queued reset", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step]);
		addHooks(setup.registry, GenerationTask, { onYield: () => ({ continue: "more" }) });
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		await root.reset(undefined, context);
		first.release();
		await input.wait(context);
		await harness.waitForIdle(context);
		expect(await status(input)).toMatchObject({ status: "done" });
		expect(transcript(await allEntries(root))).toEqual(["pi.user:a", "pi.assistant:first", "pi.reset"]);
		expect(setup.faux.state.callCount).toBe(1);
		await harness.close(context);
	});

	it("adds every steer to the run at the postTools boundary with steeringMode all", async () => {
		const setup = chatSetup();
		const gate = deferred();
		holdTool(setup, gate);
		setup.faux.setResponses([HOLD, answer("after tools"), answer("follow-up")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		setup.settings.steeringMode = "all";
		const input = await root.submit({ type: "input", content: "a" }, context);
		await toolRunning(harness, root);
		const s1 = await root.submit({ type: "input", content: "s1", whenBusy: "steer" }, context);
		const f = await root.submit({ type: "input", content: "f" }, context);
		const s2 = await root.submit({ type: "input", content: "s2", whenBusy: "steer" }, context);
		gate.resolve();
		await f.wait(context);
		const entries = await allEntries(root);
		expect(transcript(entries)).toEqual([
			"pi.user:a",
			"pi.assistant",
			"pi.tool-result",
			"pi.user:s1",
			"pi.user:s2",
			"pi.assistant:after tools",
			"pi.user:f",
			"pi.assistant:follow-up",
		]);
		const answers = entries.filter((entry) => entry.kind === "pi.assistant");
		for (const submission of [input, s1, s2]) {
			expect(await status(submission)).toMatchObject({ status: "done", answer: answers[1]!.id });
		}
		await harness.close(context);
	});

	it("queues an idle steer behind waiting items and places it with the first follow-up in ID order", async () => {
		const setup = chatSetup();
		const failing = gated(fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid request" }));
		setup.faux.setResponses([failing.step, answer("both")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await failing.reached;
		const f = await root.submit({ type: "input", content: "f" }, context);
		failing.release();
		await input.wait(context);
		await harness.waitForIdle(context);
		const steer = await root.submit({ type: "input", content: "s", whenBusy: "steer" }, context);
		const settled = await steer.wait(context);
		expect(await status(f)).toMatchObject({ status: "done", answer: settled.status === "done" && settled.answer });
		expect(transcript(await allEntries(root)).slice(-3)).toEqual(["pi.user:f", "pi.user:s", "pi.assistant:both"]);
		await harness.close(context);
	});

	it("starts a queued follow-up after a terminating round", async () => {
		const setup = chatSetup();
		const gate = deferred();
		holdTool(setup, gate, { content: [], control: { terminate: true } });
		setup.faux.setResponses([HOLD, answer("follow-up")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await toolRunning(harness, root);
		const f = await root.submit({ type: "input", content: "f" }, context);
		gate.resolve();
		await f.wait(context);
		const calling = (await allEntries(root)).find((entry) => entry.kind === "pi.assistant")!;
		expect(await status(input)).toMatchObject({ status: "done", answer: calling.id });
		expect(transcript(await allEntries(root))).toEqual([
			"pi.user:a",
			"pi.assistant",
			"pi.tool-result",
			"pi.user:f",
			"pi.assistant:follow-up",
		]);
		await harness.close(context);
	});

	it("writes the last handoff in call order and then runs queued follow-ups in the new context", async () => {
		const setup = chatSetup();
		const firstGate = deferred();
		const secondGate = deferred();
		holdTool(setup, firstGate, { content: [], control: { handoff: "one" } });
		addTool(
			setup.registry,
			defineTool({
				name: "later",
				description: "Finishes first",
				parameters: Type.Object({}),
				execute: async () => {
					await secondGate.promise;
					return { content: [], control: { handoff: "two" } };
				},
			}),
		);
		const round = fauxAssistantMessage(
			[fauxToolCall("hold", {}, { id: "c1" }), fauxToolCall("later", {}, { id: "c2" })],
			{ stopReason: "toolUse" },
		);
		setup.faux.setResponses([round, answer("follow-up")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await toolRunning(harness, root);
		const f = await root.submit({ type: "input", content: "f" }, context);
		secondGate.resolve();
		await waitFor(async () => (await harness.snapshot(LiveDoc, root.id, context))?.tools?.[1]?.status === "done");
		firstGate.resolve();
		await f.wait(context);
		expect(await status(input)).toMatchObject({ status: "done" });
		expect(transcript(await allEntries(root)).slice(-4)).toEqual([
			"pi.tool-result",
			"pi.reset:two",
			"pi.user:f",
			"pi.assistant:follow-up",
		]);
		await harness.close(context);
	});

	it("leaves the inbox alone when the run's task is aborted", async () => {
		const setup = chatSetup();
		const first = gated(answer("never"));
		setup.faux.setResponses([first.step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const f = await root.submit({ type: "input", content: "f" }, context);
		const taskId = (await harness.snapshot(LiveDoc, root.id, context))!.run!.taskId;
		await harness.abortTask(taskId, context);
		expect(await input.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		await harness.waitForIdle(context);
		expect((await status(f)).status).toBe("queued");
		expect(await inbox(harness, root)).toEqual([[f.id, "followUp"]]);
		await harness.close(context);
	});

	it("returns a queued submission for its repeated request ID without a second item", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const queued = await root.submit({ type: "input", content: "f", requestId: "r" }, context);
		const again = await root.submit({ type: "input", content: "f", requestId: "r" }, context);
		expect(again.id).toBe(queued.id);
		expect(await inbox(harness, root)).toEqual([[queued.id, "followUp"]]);
		await harness.close(context);
	});

	it("withdraws a middle item with one positional removal", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const items = [];
		for (const text of ["x", "y", "z"]) items.push(await root.submit({ type: "input", content: text }, context));
		const ops: Op[][] = [];
		harness.subscribeCommits((publication) => {
			for (const change of documentChanges(publication)) {
				if (change.record.kind === "pi.inbox" && change.ops.length > 0) ops.push([...change.ops]);
			}
		});
		await items[1]!.abort(context);
		expect(ops).toEqual([[["p", ["items"], 1, 1, []]]]);
		expect(await inbox(harness, root)).toEqual([
			[items[0]!.id, "followUp"],
			[items[2]!.id, "followUp"],
		]);
		await harness.close(context);
	});

	it("stores the inbox as a base exactly when it becomes empty", async () => {
		const written: { kind: "base" | "delta"; empty: boolean }[] = [];
		let inboxId: number | undefined;
		class RecordingStorage extends MemoryStorage {
			override async commit(
				writes: Parameters<MemoryStorage["commit"]>[0],
				callContext: Parameters<MemoryStorage["commit"]>[1],
			) {
				for (const write of writes) {
					if (write.type !== "document.change" || write.id !== inboxId) continue;
					const content = write.content;
					const empty = content.kind === "base" && (content.value as InboxState).items.length === 0;
					written.push({ kind: content.kind, empty });
				}
				return super.commit(writes, callContext);
			}
		}
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step, answer("second")]);
		const { harness, root } = await openChat(new RecordingStorage(), setup);
		harness.subscribeCommits((publication) => {
			for (const change of documentChanges(publication))
				if (change.record.kind === "pi.inbox") inboxId = change.record.id;
		});
		const input = await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		await root.submit({ type: "input", content: "f1" }, context);
		const f2 = await root.submit({ type: "input", content: "f2" }, context);
		first.release();
		await input.wait(context);
		await f2.wait(context);
		// The inbox ID is learned from the f1 push; later writes: the f2 push, removing f1, and emptying the inbox.
		expect(written).toEqual([
			{ kind: "delta", empty: false },
			{ kind: "delta", empty: false },
			{ kind: "base", empty: true },
		]);
		await harness.close(context);
	});

	it("keeps a complete inbox base exactly while it is empty, and a usage base on every change", () => {
		const info = { deltasSinceBase: 1000 } as never;
		const item = { id: 1 as never, mode: "followUp", content: "x" } as const;
		expect(InboxDoc.definition.checkpointWhen!({ items: [] }, [], info)).toBe(true);
		expect(InboxDoc.definition.checkpointWhen!({ items: [item] }, [], info)).toBe(false);
		expect(UsageDoc.definition.checkpointWhen!({ models: {}, tools: {} }, [], info)).toBe(true);
	});
});

describe("usage", () => {
	it("totals assistant usage per model and tool usage per tool, and sums the Session", async () => {
		const setup = chatSetup();
		const spent: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const gate = deferred();
		gate.resolve();
		holdTool(setup, gate, { content: [], usage: spent });
		setup.faux.setResponses([HOLD, answer("done"), answer("other")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "a" }, context)).wait(context);
		const entries = await allEntries(root);
		const assistants = entries.flatMap((entry) =>
			entry.kind === "pi.assistant" ? [entry.model![0] as AssistantMessage] : [],
		);
		const expected = assistants.reduce(
			(sum, message) => ({
				input: sum.input + message.usage.input,
				output: sum.output + message.usage.output,
				totalTokens: sum.totalTokens + message.usage.totalTokens,
			}),
			{ input: 0, output: 0, totalTokens: 0 },
		);
		const usage = (await harness.snapshot(UsageDoc, root.id, context))!;
		expect(usage.models["faux/faux-1"]).toMatchObject(expected);
		expect(usage.tools).toEqual({ hold: spent });
		const result = entries.find((entry) => entry.kind === "pi.tool-result")!.model![0] as ToolResultMessage;
		expect(result.usage).toEqual(spent);

		// A fork starts at zero; the Session total adds every conversation once.
		const fork = await root.fork(entries.at(-1)!.id, { ownership: { kind: "ownerless" } }, context);
		expect(await harness.snapshot(UsageDoc, fork.id, context)).toEqual({ models: {}, tools: {} });
		await (await fork.submit({ type: "input", content: "b" }, context)).wait(context);
		const forkUsage = (await harness.snapshot(UsageDoc, fork.id, context))!.models["faux/faux-1"]!;
		const total = await harness.usage(context);
		expect(total.models["faux/faux-1"]!.output).toBe(expected.output + forkUsage.output);
		expect(total.tools).toEqual({ hold: spent });
		await harness.close(context);
	});

	it("counts failed attempts, converted partials, and tool usage replaced by afterTool", async () => {
		const setup = chatSetup({ tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } });
		const spent: Usage = {
			input: 5,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const gate = deferred();
		gate.resolve();
		holdTool(setup, gate);
		addHooks(setup.registry, ToolTask, { afterTool: (_call, result) => ({ ...result, usage: spent }) });
		const retryable = fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" });
		setup.faux.setResponses([retryable, HOLD, answer("done"), answer("x".repeat(400))]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		setup.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
		await (await root.submit({ type: "input", content: "a" }, context)).wait(context);
		expect((await harness.snapshot(UsageDoc, root.id, context))!.tools).toEqual({ hold: spent });

		// A partial committed while streaming becomes an aborted entry on abort; its usage counts too.
		const input = await root.submit({ type: "input", content: "b" }, context);
		await waitFor(async () => (await harness.snapshot(LiveDoc, root.id, context))?.generation?.message !== undefined);
		await harness.abortTask((await harness.snapshot(LiveDoc, root.id, context))!.run!.taskId, context);
		await input.wait(context);
		const assistants = (await allEntries(root)).flatMap((entry) =>
			entry.kind === "pi.assistant" ? [entry.model![0] as AssistantMessage] : [],
		);
		expect(assistants.map((message) => message.stopReason)).toEqual(["error", "toolUse", "stop", "aborted"]);
		const output = assistants.reduce((sum, message) => sum + message.usage.output, 0);
		expect((await harness.snapshot(UsageDoc, root.id, context))!.models["faux/faux-1"]!.output).toBe(output);
		await harness.close(context);
	});

	it("keeps tools named like object prototype keys in the ledger and the Session total", async () => {
		const { harness, root } = await openChat(new MemoryStorage(), chatSetup());
		const usage: Usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const names = ["constructor", "__proto__", "toString"];
		for (const name of names) {
			await root.commit((tx) => recordUsage(tx, root.id, "tools", name, usage), context);
			await root.commit((tx) => recordUsage(tx, root.id, "tools", name, usage), context);
		}
		const total = await harness.usage(context);
		expect(Object.keys(total.tools)).toEqual(names);
		for (const name of names) expect(Object.getOwnPropertyDescriptor(total.tools, name)?.value.output).toBe(2);
		await harness.close(context);
	});

	it("keeps usage totals exact across reopen, counting a partial converted after reopen once", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-usage-"));
		directories.add(directory);
		const path = join(directory, "session.sqlite");
		const setup = chatSetup({ tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } });
		setup.faux.setResponses([answer("first"), answer("x".repeat(400)), answer("again")]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		await (await opened.root.submit({ type: "input", content: "a" }, context)).wait(context);
		await opened.root.submit({ type: "input", content: "b" }, context);
		const live = opened.harness;
		await waitFor(
			async () => (await live.snapshot(LiveDoc, opened.root.id, context))?.generation?.message !== undefined,
		);
		// Closing mid-stream keeps the committed partial; the reopened request converts it into an aborted entry.
		await opened.harness.close(context);
		opened = await openChat(await openNodeSqliteStorage(path), setup);
		opened.harness.resume();
		await opened.harness.waitForIdle(context);
		const assistants = (await allEntries(opened.root)).flatMap((entry) =>
			entry.kind === "pi.assistant" ? [entry.model![0] as AssistantMessage] : [],
		);
		expect(assistants.map((message) => message.stopReason)).toEqual(["stop", "aborted", "stop"]);
		const total = (await opened.harness.usage(context)).models["faux/faux-1"]!;
		const sum = (field: "input" | "output" | "totalTokens") =>
			assistants.reduce((value, message) => value + message.usage[field], 0);
		expect([total.input, total.output, total.totalTokens]).toEqual([sum("input"), sum("output"), sum("totalTokens")]);
		await opened.harness.close(context);
	});

	it("records usage as numeric sets on the ledger in the entry's commit", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([answer("one"), answer("two")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const commits: { entries: number; ops: readonly Op[] }[] = [];
		harness.subscribeCommits((publication) => {
			for (const change of documentChanges(publication)) {
				if (change.record.kind !== "pi.usage") continue;
				const entries = publication.changes.filter((other) => other.type === "entry").length;
				commits.push({ entries, ops: change.ops });
			}
		});
		await (await root.submit({ type: "input", content: "a" }, context)).wait(context);
		await (await root.submit({ type: "input", content: "b" }, context)).wait(context);
		expect(commits).toHaveLength(2);
		expect(commits[0]!.ops).toEqual([["s", ["models", "faux/faux-1"], expect.any(Object)]]);
		expect(commits[1]!.ops.every((op) => op[0] === "s" && op[1][1] === "faux/faux-1")).toBe(true);
		expect(commits.every((commit) => commit.entries >= 1)).toBe(true);
		await harness.close(context);
	});
});
