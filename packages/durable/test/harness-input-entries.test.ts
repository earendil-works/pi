// Inputs placed as application entries, and data-only writes appended at once (#10407).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Context as ModelContext,
	Type,
} from "@earendil-works/pi-ai";
import {
	type Conversation,
	ConversationBusy,
	defineTool,
	type EntryRecord,
	type Harness,
	InboxDoc,
	LiveDoc,
	type LiveState,
	MemoryStorage,
	type SubmissionDraft,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf, waitFor } from "./chat-support.ts";
import { addSection, addTool } from "./harness-support.ts";
import { viewHistory } from "./live-support.ts";
import { context } from "./session-support.ts";
import { aborted, type Deferred, deferred } from "./task-support.ts";

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

/** Register a `hold` tool whose calls wait for `gate`. */
function holdTool(setup: ChatSetup, gate: Deferred): void {
	addTool(
		setup.registry,
		defineTool({
			name: "hold",
			description: "Waits for the test",
			parameters: Type.Object({}),
			execute: async () => {
				await gate.promise;
				return { output: [{ type: "text", text: "held" }] };
			},
		}),
	);
}

const HOLD = fauxAssistantMessage([fauxToolCall("hold", {}, { id: "c1" })], { stopReason: "toolUse" });

/** Role and text of each request message, as the provider receives them. */
function requestLog(requests: string[][], reply: AssistantMessage): FauxResponseStep {
	return (request: ModelContext) => {
		requests.push(request.messages.map((message) => `${message.role}:${textOf(message) ?? ""}`));
		return reply;
	};
}

/** Kind, application data, and model text of each entry, skipping system entries. */
function transcript(entries: readonly EntryRecord[]): unknown[][] {
	return entries
		.filter((entry) => entry.kind !== "pi.system")
		.map((entry) => {
			const message = entry.model?.[0];
			const text = message === undefined || message.role === "toolResult" ? undefined : textOf(message);
			const data = entry.data === undefined || entry.kind.startsWith("pi.") ? [] : [entry.data];
			return [entry.kind, ...data, ...(text === undefined ? [] : [text])];
		});
}

async function inboxItems(harness: Harness, root: Conversation) {
	return (await harness.snapshot(InboxDoc, root.id, context))!.items;
}

async function toolRunning(harness: Harness, root: Conversation): Promise<void> {
	await waitFor(async () => (await harness.snapshot(LiveDoc, root.id, context))?.tools?.[0]?.status === "running");
}

const mention = (text: string) => ({ kind: "chat.mention", data: { author: "ann", text } });

describe("input entries", () => {
	it("places an idle input as its entry: the given kind and data, with the content as its user message", async () => {
		const setup = chatSetup();
		setup.now = () => 42;
		const requests: string[][] = [];
		setup.faux.setResponses([requestLog(requests, answer("hi ann"))]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "ann: hi", entry: mention("hi") }, context);
		const settled = await submission.wait(context);
		const entries = await allEntries(root);
		expect(transcript(entries)).toEqual([
			["chat.mention", { author: "ann", text: "hi" }, "ann: hi"],
			["pi.assistant", "hi ann"],
		]);
		const placed = entries.find((entry) => entry.kind === "chat.mention")!;
		expect(placed.model).toEqual([{ role: "user", content: "ann: hi", timestamp: 42 }]);
		expect(settled).toMatchObject({ status: "done", entry: placed.id, answer: entries.at(-1)!.id });
		expect(requests).toEqual([["user:ann: hi"]]);
		// The context of a fork at the input is the same as for a pi.user entry.
		const view = await root.context(context, { at: placed.id });
		expect(view.messages.filter((message) => message.role !== "system")).toEqual(placed.model);
		await harness.close(context);
	});

	it("rejects an input entry whose kind is not a non-empty string or starts with pi., writing nothing", async () => {
		const setup = chatSetup();
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const before = (await allEntries(root)).length;
		for (const kind of [123, "", "pi.user", "pi.compaction"]) {
			const draft = { type: "input", content: "x", entry: { kind } } as unknown as SubmissionDraft;
			await expect(root.submit(draft, context)).rejects.toThrow("An input entry's kind must be");
		}
		expect((await allEntries(root)).length).toBe(before);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({});
		// Writes keep their kinds: reset() writes pi.reset.
		await root.reset(undefined, context);
		expect((await allEntries(root)).at(-1)?.kind).toBe("pi.reset");
		await harness.close(context);
	});

	it("takes only kind and data from an untyped caller's entry", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([answer("idle"), first.step, answer("queued")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const extra = {
			kind: "chat.mention",
			model: [{ role: "user", content: "forged", timestamp: 0 }],
			head: "self",
			edits: [{ target: 1, action: "omit" }],
		};
		const draft = (content: string) => ({ type: "input", content, entry: extra }) as unknown as SubmissionDraft;
		await (await root.submit(draft("idle"), context)).wait(context);
		await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const queued = await root.submit(draft("later"), context);
		expect((await inboxItems(harness, root)).at(-1)).toEqual({
			id: queued.id,
			mode: "followUp",
			content: "later",
			entry: { kind: "chat.mention" },
		});
		first.release();
		await queued.wait(context);
		const mentions = (await allEntries(root)).filter((entry) => entry.kind === "chat.mention");
		expect(mentions.map((entry) => [entry.head, entry.edits, textOf(entry.model?.[0]), entry.model?.length])).toEqual(
			[
				[undefined, undefined, "idle", 1],
				[undefined, undefined, "later", 1],
			],
		);
		await harness.close(context);
	});

	it("queues busy inputs with their entries in the inbox and places them as those entries at boundaries", async () => {
		const setup = chatSetup();
		const gate = deferred();
		holdTool(setup, gate);
		setup.faux.setResponses([HOLD, answer("after tools"), answer("follow-up")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await toolRunning(harness, root);
		const steer = await root.submit(
			{ type: "input", content: "s", entry: mention("s"), whenBusy: "steer", requestId: "r-s" },
			context,
		);
		const followUp = await root.submit(
			{ type: "input", content: "f", entry: { kind: "p2.input" }, whenBusy: "followUp" },
			context,
		);
		expect(await inboxItems(harness, root)).toEqual([
			{
				id: steer.id,
				mode: "steer",
				content: "s",
				entry: { kind: "chat.mention", data: { author: "ann", text: "s" } },
			},
			{ id: followUp.id, mode: "followUp", content: "f", entry: { kind: "p2.input" } },
		]);
		// The request ID deduplicates a queued input with an entry as any other.
		const again = await root.submit(
			{ type: "input", content: "other", entry: mention("other"), whenBusy: "steer", requestId: "r-s" },
			context,
		);
		expect(again.id).toBe(steer.id);
		await expect(
			root.submit({ type: "input", content: "x", entry: mention("x"), whenBusy: "reject" }, context),
		).rejects.toBeInstanceOf(ConversationBusy);
		expect(await inboxItems(harness, root)).toHaveLength(2);

		gate.resolve();
		await followUp.wait(context);
		const entries = await allEntries(root);
		expect(transcript(entries)).toEqual([
			["pi.user", "a"],
			["pi.assistant"],
			["pi.tool-result"],
			["chat.mention", { author: "ann", text: "s" }, "s"],
			["pi.assistant", "after tools"],
			["p2.input", "f"],
			["pi.assistant", "follow-up"],
		]);
		const answers = entries.filter((entry) => entry.kind === "pi.assistant");
		const placed = (kind: string) => entries.find((entry) => entry.kind === kind)!.id;
		expect(await input.status(context)).toMatchObject({ status: "done", answer: answers[1]!.id });
		expect(await steer.status(context)).toMatchObject({
			status: "done",
			entry: placed("chat.mention"),
			answer: answers[1]!.id,
		});
		expect(await followUp.status(context)).toMatchObject({
			status: "done",
			entry: placed("p2.input"),
			answer: answers[2]!.id,
		});
		await harness.close(context);
	});

	it("withdraws queued inputs with entries, one by one and by conversation abort", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const withdrawn = await root.submit({ type: "input", content: "w", entry: mention("w") }, context);
		const aborted = await root.submit({ type: "input", content: "x", entry: mention("x") }, context);
		expect(await withdrawn.abort(context)).toBe("aborted");
		expect((await inboxItems(harness, root)).map((item) => item.id)).toEqual([aborted.id]);
		await root.abort(context);
		for (const submission of [withdrawn, aborted]) {
			expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		}
		expect(await input.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(await inboxItems(harness, root)).toEqual([]);
		expect((await allEntries(root)).some((entry) => entry.kind === "chat.mention")).toBe(false);
		await harness.close(context);
	});
});

describe("data-only writes", () => {
	it("appends a data-only write mid-run in time order, leaving the model's messages unchanged", async () => {
		const setup = chatSetup();
		const gate = deferred();
		holdTool(setup, gate);
		const requests: string[][] = [];
		setup.faux.setResponses([requestLog(requests, HOLD), requestLog(requests, answer("done"))]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const history = await viewHistory(harness, root.id);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await toolRunning(harness, root);
		const chat = { kind: "chat.message", data: { author: "bob", text: "lunch?" } };
		const write = await root.submit({ type: "write", entry: chat, requestId: "bob:1" }, context);
		// Settled and appended in its own commit, between the call and its still-running tool's result.
		const settled = await write.status(context);
		expect(settled.status).toBe("done");
		expect(await inboxItems(harness, root)).toEqual([]);
		expect(transcript(await allEntries(root))).toEqual([
			["pi.user", "a"],
			["pi.assistant"],
			["chat.message", { author: "bob", text: "lunch?" }],
		]);
		// The view shows it while the run goes on.
		const shown = history.views.find((view) => view.entries.some((entry) => entry.kind === "chat.message"));
		expect(shown?.entries.at(-1)).toMatchObject({
			kind: "chat.message",
			id: settled.status === "done" && settled.entry,
		});
		expect((shown?.docs["pi.live"] as LiveState).run?.inputs).toEqual([input.id]);
		// A repeated request ID returns the same write without a second entry.
		expect((await root.submit({ type: "write", entry: chat, requestId: "bob:1" }, context)).id).toBe(write.id);

		gate.resolve();
		await input.wait(context);
		expect(transcript(await allEntries(root))).toEqual([
			["pi.user", "a"],
			["pi.assistant"],
			["chat.message", { author: "bob", text: "lunch?" }],
			["pi.tool-result"],
			["pi.assistant", "done"],
		]);
		expect(requests).toEqual([
			["system:", "user:a"],
			["system:", "user:a", "assistant:", "toolResult:held"],
		]);
		history.detach();
		await harness.close(context);
	});

	it("queues a data-only write behind a queued reset, so it lands after the reset and stays visible", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		await root.reset(undefined, context);
		const chat = await root.submit({ type: "write", entry: { kind: "chat.message", data: "hi" } }, context);
		expect((await chat.status(context)).status).toBe("queued");
		first.release();
		await input.wait(context);
		const settled = await chat.wait(context);
		const entries = await allEntries(root);
		const reset = entries.find((entry) => entry.kind === "pi.reset")!;
		expect(settled.status === "done" && settled.entry).toBeGreaterThan(reset.id);
		expect((await root.context(context)).entries.map((entry) => entry.kind)).toEqual(["pi.reset", "chat.message"]);
		// Once the reset is placed, display-only writes go in at once again.
		const later = await root.submit({ type: "write", entry: { kind: "chat.message", data: "again" } }, context);
		expect((await later.status(context)).status).toBe("done");
		await harness.close(context);
	});

	it("leaves the request unchanged by a data-only write that lands while the generation prepares", async () => {
		const setup = chatSetup();
		const rendering = deferred();
		const render = deferred();
		let renders = 0;
		addSection(setup.registry, "slow", async () => {
			if (renders++ === 1) {
				rendering.resolve();
				await render.promise;
			}
			return "SLOW";
		});
		const requests: string[][] = [];
		setup.faux.setResponses([requestLog(requests, answer("one")), requestLog(requests, answer("two"))]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "a" }, context)).wait(context);
		const second = await root.submit({ type: "input", content: "b" }, context);
		await rendering.promise;
		await root.submit({ type: "write", entry: { kind: "chat.message", data: "hi" } }, context);
		render.resolve();
		await second.wait(context);
		expect(requests[1]).toEqual(["system:", "user:a", "assistant:one", "user:b"]);
		const kinds = (await allEntries(root)).map((entry) => entry.kind);
		// The unchanged prompt adds no second pi.system entry.
		expect(kinds).toEqual(["pi.user", "pi.system", "pi.assistant", "pi.user", "chat.message", "pi.assistant"]);
		await harness.close(context);
	});

	it("appends a data-only write while idle after a failed run without placing the queued items", async () => {
		const setup = chatSetup();
		const failing = gated(fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid request" }));
		setup.faux.setResponses([failing.step, answer("for f")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await failing.reached;
		const f = await root.submit({ type: "input", content: "f", entry: mention("f") }, context);
		failing.release();
		expect(await input.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
		await harness.waitForIdle(context);
		const note = await root.submit({ type: "write", entry: { kind: "note", data: "n" } }, context);
		expect((await note.status(context)).status).toBe("done");
		await harness.waitForIdle(context);
		expect((await f.status(context)).status).toBe("queued");
		expect((await inboxItems(harness, root)).map((item) => item.id)).toEqual([f.id]);
		expect(await harness.snapshot(LiveDoc, root.id, context)).toEqual({
			runFailure: {
				taskId: expect.any(Number),
				inputs: [input.id],
				reason: "model_error",
				detail: "invalid request",
				first: expect.any(Number),
			},
		});
		expect(setup.faux.state.callCount).toBe(1);
		// The next input places the waiting mention first.
		const g = await root.submit({ type: "input", content: "g" }, context);
		await g.wait(context);
		expect(transcript(await allEntries(root)).filter(([kind]) => kind !== "pi.assistant")).toEqual([
			["pi.user", "a"],
			["note", "n"],
			["chat.mention", { author: "ann", text: "f" }, "f"],
			["pi.user", "g"],
		]);
		await harness.close(context);
	});

	it("keeps a queued input's entry across reopen and places it as that entry", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-input-entries-"));
		const path = join(directory, "session.sqlite");
		try {
			const setup = chatSetup();
			const first = gated(answer("first"));
			setup.faux.setResponses([first.step, answer("first again"), answer("for f")]);
			let opened = await openChat(await openNodeSqliteStorage(path), setup);
			await opened.root.submit({ type: "input", content: "a" }, context);
			await first.reached;
			const f = (await opened.root.submit({ type: "input", content: "f", entry: mention("f") }, context)).id;
			await opened.harness.close(context);

			opened = await openChat(await openNodeSqliteStorage(path), setup);
			expect((await inboxItems(opened.harness, opened.root)).find((item) => item.id === f)).toMatchObject({
				entry: mention("f"),
			});
			const settled = await (await opened.harness.submission(f, context))!.wait(context);
			const placed = (await allEntries(opened.root)).find((entry) => entry.kind === "chat.mention")!;
			expect(settled).toMatchObject({ status: "done", entry: placed.id });
			expect(placed).toMatchObject({ data: mention("f").data, model: [{ role: "user", content: "f" }] });
			await opened.harness.close(context);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("appends a data-only write at once behind a non-empty inbox, and still queues writes with model or edits", async () => {
		const setup = chatSetup();
		const first = gated(answer("first"));
		setup.faux.setResponses([first.step, answer("second")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const input = await root.submit({ type: "input", content: "a" }, context);
		await first.reached;
		const followUp = await root.submit({ type: "input", content: "f" }, context);
		const model = await root.submit(
			{ type: "write", entry: { kind: "note", model: [{ role: "user", content: "m", timestamp: 0 }] } },
			context,
		);
		const target = (await allEntries(root)).find((entry) => entry.kind === "pi.user")!;
		const edit = await root.submit(
			{ type: "write", entry: { kind: "redact", edits: [{ target: target.id, action: "omit" }] } },
			context,
		);
		const note = await root.submit({ type: "write", entry: { kind: "note", data: "n" } }, context);
		expect((await note.status(context)).status).toBe("done");
		expect((await inboxItems(harness, root)).map((item) => [item.id, item.mode])).toEqual([
			[followUp.id, "followUp"],
			[model.id, "write"],
			[edit.id, "write"],
		]);
		first.release();
		await followUp.wait(context);
		expect(transcript(await allEntries(root))).toEqual([
			["pi.user", "a"],
			["note", "n"],
			["pi.assistant", "first"],
			["note", "m"],
			["redact"],
			["pi.user", "f"],
			["pi.assistant", "second"],
		]);
		expect(await input.status(context)).toMatchObject({ status: "done" });
		await harness.close(context);
	});
});
