// Deferred progress commits (`PROGRESS_COMMIT`): the partial answer and tool output reach watches at once and Storage at
// the next commit that reads or writes `pi.live` or within `settings.progress.persistWithinMs`. Crashes are simulated
// by failing the Harness: from that moment nothing more reaches Storage, as when the process dies; the reopened Harness
// resumes from what was stored.
import { applyImmutable } from "@earendil-works/chord/delta";
import { fauxAssistantMessage, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type ConversationId,
	defineTask,
	defineTool,
	type EntryRecord,
	type Harness,
	LiveDoc,
	type LiveState,
	type TaskId,
	ToolResultEntry,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { PartialMessage } from "../src/harness/partial-changes.ts";
import type { SessionImpl } from "../src/session/session.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf, waitFor } from "./chat-support.ts";
import { addTask, addTool } from "./harness-support.ts";
import { ControlledStorage, context, observeCommits } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";

/** A slow stream: 4 characters 80 times a second. */
function slowSetup(persistWithinMs: number): ChatSetup {
	const setup = chatSetup({ tokensPerSecond: 80, tokenSize: { min: 4, max: 4 } });
	setup.settings.progress = { persistWithinMs };
	return setup;
}

const LONG = "streamed ".repeat(400);

/** Open (or reopen) a Harness over `storage` and let it run tasks. */
async function open(storage: ControlledStorage, setup: ChatSetup) {
	const opened = await openChat(storage.reopen(), setup);
	opened.harness.resume();
	return { ...opened, memory: memoryPartials(opened.harness) };
}

/** The partial text of every `pi.live` revision memory adopted, the last one last. */
function memoryPartials(harness: Harness): string[] {
	const texts: string[] = [];
	observeCommits(harness, (publication) => {
		for (const change of publication.changes) {
			if (change.type !== "document" || change.record.kind !== LiveDoc.definition.kind) continue;
			// Publications carry untyped document values; this one is `pi.live`.
			const message = (change.value as LiveState | null)?.generation?.message;
			if (message !== undefined) texts.push(partialText(message) ?? "");
		}
	});
	return texts;
}

/** Fail the Harness now: nothing more is stored, held changes are lost with it. */
async function crash(harness: Harness): Promise<void> {
	// `fail()` is internal, so the public type lacks it; every Harness is a `SessionImpl`.
	(harness as unknown as SessionImpl).fail(new Error("crash"));
	await harness.closed;
}

/** `pi.live` as Storage has it, read past the Session, also after a crash closed it. */
async function storedLive(storage: ControlledStorage, conversationId: ConversationId): Promise<LiveState | undefined> {
	storage.reopen();
	const address = { kind: LiveDoc.definition.kind, scope: { kind: "conversation", conversationId } } as const;
	const record = await storage.findDocument(address, "current", context);
	if (record === undefined) return undefined;
	// Storage values are untyped; this one is `pi.live`.
	return (await storage.document(record.id, "current", context))?.value as LiveState | undefined;
}

/** The text of a partial message's first text block. */
function partialText(message: PartialMessage | undefined): string | undefined {
	const block = message?.content.find((candidate) => candidate.type === "text");
	return block?.type === "text" ? block.text : undefined;
}

function storedText(live: LiveState | undefined): string | undefined {
	const message = live?.generation?.message;
	return message === undefined ? undefined : (partialText(message) ?? "");
}

/** Assistant entries: their text and stop reason. */
function answers(entries: readonly EntryRecord[]): { text: string | undefined; stopReason: string | undefined }[] {
	return entries
		.filter((entry) => AssistantEntry.is(entry))
		.map((entry) => {
			const message = entry.model![0]!;
			return { text: textOf(message), stopReason: message.role === "assistant" ? message.stopReason : undefined };
		});
}

async function generationId(harness: Harness, conversationId: ConversationId): Promise<TaskId> {
	return (await harness.snapshot(LiveDoc, conversationId, context))!.run!.taskId;
}

describe("generation partials", () => {
	it("hold partials in memory and store them together, at most every persistWithinMs", async () => {
		const storage = new ControlledStorage();
		const setup = slowSetup(400);
		setup.faux.setResponses([fauxAssistantMessage(LONG.slice(0, 640))]);
		const { harness, root, memory } = await open(storage, setup);
		const from = storage.commits.length;
		await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
		const writesLive = storage.commits
			.slice(from)
			.filter((batch) => batch.some((write) => write.type === "document.change"));
		// About 2 s of streaming at 100 ms per partial: some 20 partials in memory, a store about every 400 ms.
		expect(memory.length).toBeGreaterThan(12);
		expect(writesLive.length).toBeLessThan(memory.length / 1.5);
		await harness.close(context);
	});

	it("converts what was stored into the aborted entry after a crash, and resends", async () => {
		const storage = new ControlledStorage();
		const setup = slowSetup(150);
		setup.faux.setResponses([fauxAssistantMessage(LONG)]);
		let opened = await open(storage, setup);
		// A replica fed by subscribeCommits() alone, as a replication feed would be.
		let replica = await storedLive(storage, opened.root.id);
		opened.harness.subscribeCommits((publication) => {
			for (const change of publication.changes) {
				if (change.type === "document" && change.record.kind === LiveDoc.definition.kind) {
					replica = applyImmutable(replica, change.ops);
				}
			}
		});
		const submission = await opened.root.submit({ type: "input", content: "hi" }, context);
		await waitFor(async () => (storedText(await storedLive(storage, opened.root.id))?.length ?? 0) > 40);
		const inMemory = opened.memory.at(-1)!;
		await crash(opened.harness);
		const stored = storedText(await storedLive(storage, opened.root.id))!;
		// What Storage has is a state memory had, behind it by at most the window, and what the replica has.
		expect(opened.memory).toContain(stored);
		expect(inMemory.startsWith(stored)).toBe(true);
		expect(replica).toEqual(await storedLive(storage, opened.root.id));

		setup.faux.setResponses([fauxAssistantMessage("answer")]);
		opened = await open(storage, setup);
		expect((await (await opened.harness.submission(submission.id, context))!.wait(context)).status).toBe("done");
		expect(answers(await allEntries(opened.root))).toEqual([
			{ text: stored, stopReason: "aborted" },
			{ text: "answer", stopReason: "stop" },
		]);
		expect(await opened.harness.snapshot(LiveDoc, opened.root.id, context)).toEqual({});
		await opened.harness.close(context);
	});

	it("leaves no aborted entry for a stream that crashed before its first store", async () => {
		const storage = new ControlledStorage();
		const setup = slowSetup(Number.POSITIVE_INFINITY);
		setup.faux.setResponses([fauxAssistantMessage(LONG)]);
		let opened = await open(storage, setup);
		const submission = await opened.root.submit({ type: "input", content: "hi" }, context);
		await waitFor(() => (opened.memory.at(-1)?.length ?? 0) > 40);
		await crash(opened.harness);
		expect(await storedLive(storage, opened.root.id)).toMatchObject({ generation: { attempt: 1 } });
		expect(storedText(await storedLive(storage, opened.root.id))).toBeUndefined();

		setup.faux.setResponses([fauxAssistantMessage("answer")]);
		opened = await open(storage, setup);
		expect((await (await opened.harness.submission(submission.id, context))!.wait(context)).status).toBe("done");
		expect(answers(await allEntries(opened.root))).toEqual([{ text: "answer", stopReason: "stop" }]);
		await opened.harness.close(context);
	});

	it("converts a stored partial once through two crashes, before and after the conversion", async () => {
		const storage = new ControlledStorage();
		const setup = slowSetup(150);
		setup.faux.setResponses([fauxAssistantMessage(LONG)]);
		let opened = await open(storage, setup);
		const submission = await opened.root.submit({ type: "input", content: "hi" }, context);
		await waitFor(async () => (storedText(await storedLive(storage, opened.root.id))?.length ?? 0) > 40);
		await crash(opened.harness);
		const stored = storedText(await storedLive(storage, opened.root.id))!;

		// Crash again before anything ran: nothing was converted, so nothing is lost or doubled.
		opened = { ...(await openChat(storage.reopen(), setup)), memory: [] };
		await crash(opened.harness);
		expect(storedText(await storedLive(storage, opened.root.id))).toBe(stored);

		// Crash again while the resend streams: its conversion is stored, its own partials only held.
		setup.settings.progress = { persistWithinMs: Number.POSITIVE_INFINITY };
		setup.faux.setResponses([fauxAssistantMessage(LONG)]);
		opened = await open(storage, setup);
		await waitFor(() => (opened.memory.at(-1)?.length ?? 0) > 40);
		await crash(opened.harness);
		expect(storedText(await storedLive(storage, opened.root.id))).toBeUndefined();

		setup.faux.setResponses([fauxAssistantMessage("answer")]);
		opened = await open(storage, setup);
		expect((await (await opened.harness.submission(submission.id, context))!.wait(context)).status).toBe("done");
		expect(answers(await allEntries(opened.root))).toEqual([
			{ text: stored, stopReason: "aborted" },
			{ text: "answer", stopReason: "stop" },
		]);
		await opened.harness.close(context);
	});

	it("stores everything held at a clean close", async () => {
		const storage = new ControlledStorage();
		const setup = slowSetup(Number.POSITIVE_INFINITY);
		setup.faux.setResponses([fauxAssistantMessage(LONG)]);
		let opened = await open(storage, setup);
		const submission = await opened.root.submit({ type: "input", content: "hi" }, context);
		await waitFor(() => (opened.memory.at(-1)?.length ?? 0) > 40);
		await opened.harness.close(context);
		const atClose = opened.memory.at(-1)!;
		expect(storedText(await storedLive(storage, opened.root.id))).toBe(atClose);

		setup.faux.setResponses([fauxAssistantMessage("answer")]);
		opened = await open(storage, setup);
		await (await opened.harness.submission(submission.id, context))!.wait(context);
		expect(answers(await allEntries(opened.root))[0]).toEqual({ text: atClose, stopReason: "aborted" });
		await opened.harness.close(context);
	});

	it("never counts partial commits as progress of a task cut off again and again", async () => {
		const storage = new ControlledStorage();
		const setup = slowSetup(50);
		let opened = await open(storage, setup);
		setup.faux.setResponses([fauxAssistantMessage(LONG)]);
		await opened.root.submit({ type: "input", content: "hi" }, context);
		const id = await generationId(opened.harness, opened.root.id);
		for (let crashes = 1; crashes <= 2; crashes++) {
			await waitFor(async () => (storedText(await storedLive(storage, opened.root.id))?.length ?? 0) > 40);
			await crash(opened.harness);
			setup.faux.setResponses([fauxAssistantMessage(LONG)]);
			opened = await open(storage, setup);
			expect((await opened.harness.getTask(id, context))?.restarts).toBe(crashes);
		}
		await opened.harness.close(context);
	});

	it("resumes polling a deferred response after a crash", async () => {
		const storage = new ControlledStorage();
		const setup = chatSetup({ deferred: { pollAfterMs: 60_000 } });
		let now = 1_000;
		setup.now = () => now;
		setup.faux.setResponses([fauxAssistantMessage("deferred answer")]);
		let opened = await open(storage, setup);
		setup.settings.stream = { deferred: true };
		const id = (await opened.root.submit({ type: "input", content: "hi" }, context)).id;
		await waitFor(async () => (await storedLive(storage, opened.root.id))?.generation?.deferred !== undefined);
		await crash(opened.harness);
		opened = await open(storage, setup);
		now = 61_000;
		opened.harness.resume();
		const settled = await (await opened.harness.submission(id, context))!.wait(context);
		if (settled.status !== "done" || settled.type !== "input") throw new Error(`Unexpected ${settled.status}`);
		const answer = await opened.root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		expect(textOf(answer?.model?.[0])).toBe("deferred answer");
		expect(setup.faux.state.deferredFetchCount).toBe(1);
		await opened.harness.close(context);
	});
});

describe("tool output", () => {
	/**
	 * A tool that writes a line every 20 ms until its invocation is cancelled on its first run. A later run waits for
	 * cancellation while `stall` is set (`stalled` resolves then), and otherwise writes one line and returns.
	 */
	function streamingTool(replay: "safe" | "unsafe") {
		const lines: string[] = [];
		const state = { runs: 0, lines, stall: false, stalled: deferred() };
		const registration = defineTool({
			name: "work",
			description: "work",
			parameters: Type.Object({}),
			replay,
			execute: async (_args, api, callContext) => {
				const run = ++state.runs;
				const signal = callContext.abortSignal!;
				if (run > 1 && state.stall) {
					state.stalled.resolve();
					return aborted(signal);
				}
				if (run > 1) {
					api.output(`rerun ${run}\n`);
					return {};
				}
				for (let line = 0; !signal.aborted; line++) {
					api.output(`line ${line}\n`);
					state.lines.push(`line ${line}\n`);
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				return aborted(signal);
			},
		});
		return { registration, state };
	}

	async function storedOutput(storage: ControlledStorage, conversationId: ConversationId) {
		return (await storedLive(storage, conversationId))?.tools?.[0]?.output;
	}

	function results(entries: readonly EntryRecord[]): string[] {
		return entries
			.filter((entry) => ToolResultEntry.is(entry))
			.map((entry) => {
				const message = entry.model![0]!;
				if (message.role !== "toolResult") return "";
				return message.content.map((item) => (item.type === "text" ? item.text : "")).join("|");
			});
	}

	it("answers a tool without replay that crashed with the output stored by then", async () => {
		const storage = new ControlledStorage();
		const setup = slowSetup(150);
		const { registration, state } = streamingTool("unsafe");
		addTool(setup.registry, registration);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("work", {}, { id: "c1" })], { stopReason: "toolUse" }),
		]);
		let opened = await open(storage, setup);
		const submission = await opened.root.submit({ type: "input", content: "go" }, context);
		await waitFor(async () => ((await storedOutput(storage, opened.root.id))?.length ?? 0) > 20);
		await crash(opened.harness);
		const stored = (await storedOutput(storage, opened.root.id))!;
		expect(state.lines.join("").startsWith(stored)).toBe(true);

		setup.faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
		opened = await open(storage, setup);
		expect((await (await opened.harness.submission(submission.id, context))!.wait(context)).status).toBe("done");
		expect(state.runs).toBe(1);
		expect(results(await allEntries(opened.root))).toEqual([
			`${stored}|<harness>\n[error] Tool work was interrupted and may have partially run\n</harness>`,
		]);
		await opened.harness.close(context);
	});

	it("reruns a replay-safe tool after a crash with its stored progress cleared, also through a second crash", async () => {
		const storage = new ControlledStorage();
		const setup = slowSetup(150);
		const { registration, state } = streamingTool("safe");
		addTool(setup.registry, registration);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("work", {}, { id: "c1" })], { stopReason: "toolUse" }),
		]);
		let opened = await open(storage, setup);
		const submission = await opened.root.submit({ type: "input", content: "go" }, context);
		await waitFor(async () => ((await storedOutput(storage, opened.root.id))?.length ?? 0) > 20);
		await crash(opened.harness);

		// The rerun's first commit stores the cleared progress; it crashes again before writing any of its own.
		state.stall = true;
		opened = await open(storage, setup);
		await state.stalled.promise;
		expect(await storedOutput(storage, opened.root.id)).toBeUndefined();
		await crash(opened.harness);
		expect(await storedOutput(storage, opened.root.id)).toBeUndefined();

		state.stall = false;
		setup.faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
		opened = await open(storage, setup);
		expect((await (await opened.harness.submission(submission.id, context))!.wait(context)).status).toBe("done");
		expect(state.runs).toBe(3);
		expect(results(await allEntries(opened.root))).toEqual(["rerun 3\n"]);
		await opened.harness.close(context);
	});
});

describe("compaction", () => {
	it("reruns a summarization cut off by a crash from its checkpoint", async () => {
		const storage = new ControlledStorage();
		const setup = chatSetup();
		setup.settings.compaction = { enabled: false, reserveTokens: 1000, keepRecentTokens: 150, backgroundTokens: 0 };
		const summarizing = deferred();
		setup.faux.setResponses([
			...["a1", "a2", "a3"].map((label) => fauxAssistantMessage(`${label} ${"word ".repeat(100)}`)),
			async (_request, options) => {
				summarizing.resolve();
				return aborted(options!.signal!);
			},
		]);
		let opened = await open(storage, setup);
		for (const label of ["u1", "u2", "u3"]) {
			await (await opened.root.submit({ type: "input", content: `${label} ${"word ".repeat(100)}` }, context)).wait(
				context,
			);
		}
		const id = await opened.root.compact(undefined, context);
		await summarizing.promise;
		await crash(opened.harness);

		setup.faux.setResponses([fauxAssistantMessage("SUMMARY")]);
		opened = await open(storage, setup);
		expect((await opened.harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
		await waitFor(async () => (await allEntries(opened.root)).some((entry) => entry.kind === "pi.compaction"));
		expect(await opened.harness.snapshot(LiveDoc, opened.root.id, context)).toEqual({});
		await opened.harness.close(context);
	});
});

describe("reading pi.live in a commit", () => {
	it("stores the held partial a third-party task's commit read, with what it derived", async () => {
		const storage = new ControlledStorage();
		const setup = slowSetup(Number.POSITIVE_INFINITY);
		const Audit = defineTask<{ conversationId: ConversationId }, { phase: "run" }, null>({
			name: "test.audit",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (task, runtime, ctx) => {
					await runtime.commit(async (tx) => {
						const live = await tx.doc(LiveDoc, task.input.conversationId);
						const text = partialText(live.generation?.message) ?? "";
						await tx.appendEntry(task.input.conversationId, { kind: "test.audit", data: text });
						return { status: "terminal", outcome: { status: "completed", result: null } };
					}, ctx);
				},
			},
			abort: async () => {},
		});
		addTask(setup.registry, Audit);
		setup.faux.setResponses([fauxAssistantMessage(LONG)]);
		let opened = await open(storage, setup);
		const submission = await opened.root.submit({ type: "input", content: "hi" }, context);
		await waitFor(() => (opened.memory.at(-1)?.length ?? 0) > 40);
		const conversationId = opened.root.id;
		const audit = await opened.harness.commit(
			(tx) => tx.createTask(Audit, { conversationId }, { ownership: { kind: "conversation" }, conversationId }),
			context,
		);
		await opened.harness.waitForTask(audit, context);
		const derived = String((await allEntries(opened.root)).find((entry) => entry.kind === "test.audit")!.data);
		expect(derived.length).toBeGreaterThan(40);
		// The read stored the partial it saw, in the same storage transaction as the entry.
		const batch = storage.commits.find((writes) =>
			writes.some((write) => write.type === "entry" && write.value.kind === "test.audit"),
		)!;
		expect(batch.some((write) => write.type === "document.change")).toBe(true);
		await crash(opened.harness);
		expect(storedText(await storedLive(storage, conversationId))).toBe(derived);

		setup.faux.setResponses([fauxAssistantMessage("answer")]);
		opened = await open(storage, setup);
		await (await opened.harness.submission(submission.id, context))!.wait(context);
		expect(answers(await allEntries(opened.root))[0]).toEqual({ text: derived, stopReason: "aborted" });
		await opened.harness.close(context);
	});
});
