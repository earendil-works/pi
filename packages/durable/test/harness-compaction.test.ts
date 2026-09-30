import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
	type SimpleStreamOptions,
	type TranscriptContext,
	Type,
	type UserMessage,
} from "@earendil-works/pi-ai";
import {
	type AgentEvent,
	type CompactionPolicy,
	type CompactionResult,
	CompactionTask,
	type ContextView,
	type Conversation,
	defineTask,
	type EntryRecord,
	type Harness,
	LiveDoc,
	MemoryStorage,
	StorageRejected,
	type TaskId,
	UsageDoc,
	watchEvents,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { selectCut, serializeConversation } from "../src/harness/compaction.ts";
import { orderToolResults } from "../src/harness/context.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf, waitFor } from "./chat-support.ts";
import { ControlledStorage, context } from "./session-support.ts";
import { aborted, type Deferred, deferred } from "./task-support.ts";

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-compaction-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

/** Text of about `tokens` estimated tokens, starting with `label`. */
function text(label: string, tokens: number): string {
	return `${label} ${"x".repeat(Math.max(0, tokens * 4 - label.length - 1))}`;
}

type Request = {
	readonly messages: readonly Message[];
	readonly options: SimpleStreamOptions | undefined;
	readonly model: string;
};
type Step = AssistantMessage | ((request: Request) => AssistantMessage | Promise<AssistantMessage>);

/** Scripted faux model that answers agent requests and summarization requests from separate queues. */
type Script = {
	readonly agent: Step[];
	readonly summaries: Step[];
	readonly agentRequests: Request[];
	readonly summaryRequests: Request[];
};

function isSummaryRequest(messages: readonly Message[]): boolean {
	const first = messages[0];
	return (
		first?.role === "system" &&
		typeof first.content === "string" &&
		first.content.startsWith("You are a context summarization assistant")
	);
}

function script(setup: ChatSetup): Script {
	const result: Script = { agent: [], summaries: [], agentRequests: [], summaryRequests: [] };
	setup.faux.setResponses(
		Array.from(
			{ length: 500 },
			() =>
				async (
					transcript: TranscriptContext,
					options?: SimpleStreamOptions,
					_state?: unknown,
					model?: { id: string },
				) => {
					const request = { messages: [...transcript.messages], options, model: model!.id };
					const summary = isSummaryRequest(request.messages);
					(summary ? result.summaryRequests : result.agentRequests).push(request);
					const step = (summary ? result.summaries : result.agent).shift();
					if (step === undefined) throw new Error(`No scripted ${summary ? "summary" : "agent"} response`);
					return typeof step === "function" ? step(request) : step;
				},
		),
	);
	return result;
}

/** A step that waits for `gate`, or rejects when the request is cancelled. */
function gated(gate: Deferred, message: AssistantMessage, reached?: Deferred): Step {
	return async ({ options }) => {
		reached?.resolve();
		await Promise.race([gate.promise, aborted(options!.signal!)]);
		return message;
	};
}

const answer = (content: string) => fauxAssistantMessage(content);
const failure = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage });

const OVERFLOW = "prompt is too long: 250000 tokens > 200000 maximum";

/** Small thresholds: no automatic compaction unless a test enables it. */
const MANUAL: CompactionPolicy = { enabled: false, reserveTokens: 1000, keepRecentTokens: 150, backgroundTokens: 0 };

type Chat = {
	readonly harness: Harness;
	readonly root: Conversation;
	readonly setup: ChatSetup;
	readonly faux: Script;
};

async function open(
	options: {
		readonly policy?: CompactionPolicy;
		readonly contextWindow?: number;
		readonly storage?: MemoryStorage;
	} = {},
	setup = chatSetup({ models: [{ id: "faux-1", contextWindow: options.contextWindow ?? 100_000, maxTokens: 900 }] }),
	faux = script(setup),
): Promise<Chat> {
	setup.registry.systemPrompt.section("preamble", () => "You are helpful.", { tag: false });
	const { harness, root } = await openChat(options.storage ?? new MemoryStorage(), setup);
	await root.setCompaction(options.policy ?? MANUAL, context);
	await root.setRetryPolicy({ enabled: true, maxRetries: 2, baseDelayMs: 1 }, context);
	harness.resume();
	return { harness, root, setup, faux };
}

/** Run one turn: `user` answered by `reply`. */
async function turn(chat: Chat, user: string, reply: string): Promise<void> {
	chat.faux.agent.push(answer(reply));
	const submission = await chat.root.submit({ type: "input", content: user }, context);
	expect((await submission.wait(context)).status).toBe("done");
}

/** Three turns of about 100-token messages. */
async function history(chat: Chat): Promise<void> {
	await turn(chat, text("u1", 100), text("a1", 100));
	await turn(chat, text("u2", 100), text("a2", 100));
	await turn(chat, text("u3", 100), text("a3", 100));
}

const summary = (content = "SUMMARY") => answer(content);

async function result(chat: Chat, id: TaskId<CompactionResult>) {
	const record = await chat.harness.waitForTask(id, context);
	return record.state.outcome;
}

async function kinds(conversation: Conversation): Promise<string[]> {
	return (await allEntries(conversation)).map((entry) => entry.kind);
}

async function live(chat: Chat) {
	return (await chat.harness.snapshot(LiveDoc, chat.root.id, context)) ?? {};
}

function userText(message: Message | undefined): string {
	return textOf(message) ?? "";
}

// ─── Range selection ──────────────────────────────────────────────────────

let nextId = 1;
function entry(kind: string, model: Message[], head?: number): EntryRecord {
	return {
		id: nextId++,
		conversationId: 1,
		kind,
		model,
		...(head === undefined ? {} : { head }),
	} as unknown as EntryRecord;
}
const user = (content: string): UserMessage => ({ role: "user", content, timestamp: 0 });
const assistant = (content: string, calls: string[] = [], stopReason: AssistantMessage["stopReason"] = "stop") =>
	({
		...fauxAssistantMessage([
			{ type: "text", text: content },
			...calls.map((id) => fauxToolCall("read", {}, { id })),
		]),
		stopReason,
	}) as AssistantMessage;
const toolResult = (callId: string, content: string): Message => ({
	role: "toolResult",
	toolCallId: callId,
	toolName: "read",
	content: [{ type: "text", text: content }],
	isError: false,
	timestamp: 0,
});

/** A view over `entries` whose contributions are their models, with excluded assistants removed. */
function view(entries: EntryRecord[], head?: EntryRecord): ContextView {
	const all = head === undefined ? entries : [head, ...entries];
	const contributions = all.map((record) =>
		(record.model ?? []).filter(
			(message) => message.role !== "assistant" || !["error", "aborted", "deferred"].includes(message.stopReason),
		),
	);
	return { head, entries: all, contributions, messages: orderToolResults(contributions.flat()) };
}

describe("range selection", () => {
	it("keeps about keepRecentTokens and cuts at the first candidate at or after the budget (spec §8.7 example)", () => {
		const entries = [
			entry("pi.user", [user(text("1", 10))]),
			entry("pi.assistant", [assistant("2", ["c1"])]),
			entry("pi.tool-result", [toolResult("c1", text("3", 3000))]),
			entry("pi.assistant", [assistant(text("4", 10))]),
			entry("pi.user", [user(text("5", 10))]),
			entry("pi.assistant", [assistant(text("6", 10))]),
		];
		expect(selectCut(view(entries), 2000)).toBe(3);
	});

	it("cuts at a user entry", () => {
		const entries = [
			entry("pi.user", [user(text("u1", 100))]),
			entry("pi.assistant", [assistant(text("a1", 100))]),
			entry("pi.user", [user(text("u2", 100))]),
			entry("pi.assistant", [assistant(text("a2", 100))]),
		];
		expect(selectCut(view(entries), 150)).toBe(2);
	});

	it("cuts at an assistant in the middle of one long run and never at a tool result", () => {
		const entries = [entry("pi.user", [user("do it")])];
		for (let index = 0; index < 5; index++) {
			entries.push(entry("pi.assistant", [assistant(`step ${index}`, [`c${index}`])]));
			entries.push(entry("pi.tool-result", [toolResult(`c${index}`, text(`r${index}`, 100))]));
		}
		const cut = selectCut(view(entries), 150)!;
		// The budget is reached at the fourth result; the cut is the last call, whose result it keeps.
		expect(entries[cut]!.kind).toBe("pi.assistant");
		expect(cut).toBe(9);
	});

	it("keeps a huge last tool result together with its assistant", () => {
		const entries = [
			entry("pi.user", [user("u")]),
			entry("pi.assistant", [assistant("a", ["c"])]),
			entry("pi.tool-result", [toolResult("c", text("big", 5000))]),
		];
		expect(selectCut(view(entries), 100)).toBe(1);
	});

	it("never cuts at a system entry or an excluded error or aborted answer", () => {
		const entries = [
			entry("pi.user", [user(text("u1", 100))]),
			entry("pi.assistant", [assistant(text("a1", 100))]),
			entry("pi.system", [{ role: "system", content: "", sections: { s: text("s", 100) }, timestamp: 0 }]),
			entry("pi.assistant", [assistant(text("err", 100), [], "error")]),
			entry("pi.assistant", [assistant(text("stopped", 100), [], "aborted")]),
			entry("pi.assistant", [assistant(text("a2", 100))]),
		];
		// The walk reaches 150 at the system entry; the excluded answers after it contribute nothing.
		expect(selectCut(view(entries), 150)).toBe(5);
	});

	it("follows edited contributions: an omitted entry adds nothing and is no candidate", () => {
		const entries = [
			entry("pi.user", [user(text("u1", 100))]),
			entry("pi.assistant", [assistant(text("a1", 100))]),
			entry("pi.user", [user(text("u2", 100))]),
			entry("pi.assistant", [assistant(text("a2", 100))]),
		];
		const plain = view(entries);
		expect(selectCut(plain, 150)).toBe(2);
		const contributions = plain.contributions.map((messages, index) => (index === 2 ? [] : messages));
		const omitted = { ...plain, contributions, messages: orderToolResults(contributions.flat()) };
		expect(selectCut(omitted, 150)).toBe(1);
	});

	it("does not cut at a user entry that a result of the preceding call still follows", () => {
		const entries = [
			entry("pi.user", [user(text("u1", 100))]),
			entry("pi.assistant", [assistant("a", ["c"])]),
			entry("pi.user", [user(text("steer", 100))]),
			entry("pi.tool-result", [toolResult("c", text("r", 100))]),
			entry("pi.assistant", [assistant(text("a2", 100))]),
		];
		// The budget is reached at the steer; its result follows it, so the cut moves to the next assistant.
		expect(selectCut(view(entries), 250)).toBe(4);
	});

	it("finds nothing when the budget is never reached or only the marker precedes the cut", () => {
		const small = [entry("pi.user", [user("hi")]), entry("pi.assistant", [assistant("hello")])];
		expect(selectCut(view(small), 150)).toBeUndefined();
		const marker = entry("pi.compaction", [user("summary")], 0);
		// The budget is reached at the only entry after the marker, so the marker alone would be summarized.
		expect(selectCut(view([entry("pi.user", [user(text("u", 200))])], marker), 150)).toBeUndefined();
	});

	it("summarizes an earlier summary marker first", () => {
		const marker = entry("pi.compaction", [user("EARLIER")], 0);
		const kept = [
			entry("pi.user", [user(text("u1", 100))]),
			entry("pi.assistant", [assistant(text("a1", 100))]),
			entry("pi.user", [user(text("u2", 100))]),
			entry("pi.assistant", [assistant(text("a2", 100))]),
		];
		const selected = view(kept, marker);
		expect(selectCut(selected, 150)).toBe(3);
		expect(serializeConversation(selected.contributions.slice(0, 3).flat())).toMatch(/^\[User\]: EARLIER/);
	});
});

describe("serialization", () => {
	it("writes a transcript, truncates tool results, and omits system messages", () => {
		const call = fauxToolCall("read", { path: "a.ts" }, { id: "c" });
		const messages: Message[] = [
			{ role: "system", content: "", sections: { s: "hidden" }, timestamp: 0 },
			user("hello"),
			{
				...fauxAssistantMessage([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "sure" }, call]),
			},
			toolResult("c", "y".repeat(2500)),
		];
		const serialized = serializeConversation(messages);
		expect(serialized).not.toContain("hidden");
		expect(serialized).toContain("[User]: hello");
		expect(serialized).toContain("[Assistant thinking]: hmm");
		expect(serialized).toContain("[Assistant]: sure");
		expect(serialized).toContain('[Assistant tool calls]: read(path="a.ts")');
		expect(serialized).toContain(`[Tool result]: ${"y".repeat(2000)}\n\n[... 500 more characters truncated]`);
	});
});

// ─── Manual compaction ────────────────────────────────────────────────────

describe("manual compaction", () => {
	it("places the summary at once when idle and keeps raw history", async () => {
		const chat = await open();
		await history(chat);
		const before = await allEntries(chat.root);
		const usageBefore = (await chat.harness.snapshot(UsageDoc, chat.root.id, context))!.models["faux/faux-1"]!;
		chat.faux.summaries.push(summary());

		const id = await chat.root.compact("focus on files", context);
		const outcome = await result(chat, id);
		expect(outcome.status).toBe("completed");
		const submissionId = outcome.status === "completed" ? outcome.result.submissionId : undefined;
		const placed = await (await chat.harness.submission(submissionId!, context))!.wait(context);
		expect(placed.status).toBe("done");

		// Raw history is unchanged; one summary entry heads the first kept entry, u3.
		const after = await allEntries(chat.root);
		expect(after.slice(0, before.length)).toEqual(before);
		const marker = after.at(-1)!;
		const u3 = before.find((record) => userText(record.model?.[0]).startsWith("u3"))!;
		expect(marker).toMatchObject({ kind: "pi.compaction", head: u3.id, data: { reason: "manual" } });
		expect(placed.status === "done" && placed.entry).toBe(marker.id);
		expect(userText(marker.model?.[0])).toBe(
			"The conversation history before this point was compacted into the following summary:\n\n<summary>\nSUMMARY\n</summary>",
		);

		// The model context is the summary followed by the kept entries.
		const view = await chat.root.context(context);
		expect(view.messages.map(userText)).toEqual([userText(marker.model?.[0]), text("u3", 100), text("a3", 100)]);

		// The summarizer saw the serialized prefix, the prompt, and the instructions, without tools or caching.
		const request = chat.faux.summaryRequests[0]!;
		expect(request.messages).toHaveLength(2);
		const prompt = userText(request.messages[1]);
		expect(prompt).toMatch(/^<conversation>\n\[User\]: u1 /);
		expect(prompt).toContain("[Assistant]: a2 ");
		expect(prompt).not.toContain("u3 ");
		expect(prompt).toContain("## Goal");
		expect(prompt.endsWith("\n\nAdditional focus: focus on files")).toBe(true);
		expect(request.options).toMatchObject({ cacheRetention: "none", maxTokens: 800 });
		expect(request.options?.deferred).toBeUndefined();

		// The summarizer's spend is in the ledger, and nothing counts it again later.
		const usage = (await chat.harness.snapshot(UsageDoc, chat.root.id, context))!.models["faux/faux-1"]!;
		expect(usage.input).toBeGreaterThan(usageBefore.input);
		await turn(chat, "next", "done");
		const agent = chat.faux.agentRequests.at(-1)!.messages;
		// The next request: the summary, the kept turn, the new input, then one complete system baseline.
		expect(agent.map((message) => message.role)).toEqual(["user", "user", "assistant", "user", "system"]);
		expect(agent[4]).toMatchObject({ sections: { preamble: "You are helpful." } });
		await chat.harness.close(context);
	});

	it("keeps working while busy and places the summary at the next final boundary", async () => {
		const chat = await open();
		await history(chat);
		const gate = deferred();
		const reached = deferred();
		chat.faux.agent.push(gated(gate, answer("late answer"), reached));
		const input = await chat.root.submit({ type: "input", content: "busy" }, context);
		await reached.promise;
		chat.faux.summaries.push(summary());
		const outcome = await result(chat, await chat.root.compact(undefined, context));
		const submissionId = outcome.status === "completed" ? outcome.result.submissionId! : undefined;
		expect((await (await chat.harness.submission(submissionId!, context))!.status(context)).status).toBe("queued");
		gate.resolve();
		expect((await input.wait(context)).status).toBe("done");
		const placed = await (await chat.harness.submission(submissionId!, context))!.wait(context);
		expect(placed.status).toBe("done");
		// The summary follows the answer; the kept range still includes the busy turn.
		expect((await kinds(chat.root)).slice(-3)).toEqual(["pi.user", "pi.assistant", "pi.compaction"]);
		await chat.harness.close(context);
	});

	it("places a queued summary at postTools and the run continues in the compacted context", async () => {
		const chat = await open();
		chat.setup.registry.tools.add({
			name: "wait",
			description: "wait",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "waited" }] }),
		});
		await chat.root.setActiveTools(["wait"], context);
		await history(chat);
		const gate = deferred();
		const reached = deferred();
		chat.faux.agent.push(
			gated(gate, fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }), reached),
		);
		chat.faux.agent.push(answer("after tools"));
		const input = await chat.root.submit({ type: "input", content: "use a tool" }, context);
		await reached.promise;
		chat.faux.summaries.push(summary());
		await result(chat, await chat.root.compact(undefined, context));
		gate.resolve();
		expect((await input.wait(context)).status).toBe("done");
		// The continuation request starts with the summary.
		const continuation = chat.faux.agentRequests.at(-1)!.messages;
		expect(userText(continuation[0])).toContain("<summary>\nSUMMARY\n</summary>");
		expect((await kinds(chat.root)).slice(-4)).toEqual([
			"pi.tool-result",
			"pi.compaction",
			"pi.system",
			"pi.assistant",
		]);
		await chat.harness.close(context);
	});

	it("runs follow-ups left by a failed run after placing the summary", async () => {
		const chat = await open();
		await history(chat);
		const gate = deferred();
		const reached = deferred();
		chat.faux.agent.push(gated(gate, failure("bad request"), reached));
		const failed = await chat.root.submit({ type: "input", content: "fails" }, context);
		await reached.promise;
		const followUp = await chat.root.submit({ type: "input", content: "follow-up" }, context);
		gate.resolve();
		expect((await failed.wait(context)).status).toBe("unanswered");
		expect((await followUp.status(context)).status).toBe("queued");

		chat.faux.summaries.push(summary());
		chat.faux.agent.push(answer("followed"));
		await result(chat, await chat.root.compact(undefined, context));
		expect((await followUp.wait(context)).status).toBe("done");
		const request = chat.faux.agentRequests.at(-1)!.messages;
		expect(userText(request[0])).toContain("SUMMARY");
		expect(request.some((message) => userText(message) === "follow-up")).toBe(true);
		await chat.harness.close(context);
	});

	it("settles stale when a reset lands while it summarizes", async () => {
		const chat = await open();
		await history(chat);
		const gate = deferred();
		const reached = deferred();
		chat.faux.summaries.push(gated(gate, summary(), reached));
		const id = await chat.root.compact(undefined, context);
		await reached.promise;
		await chat.root.reset(undefined, context);
		gate.resolve();
		const outcome = await result(chat, id);
		const submissionId = outcome.status === "completed" ? outcome.result.submissionId! : undefined;
		expect(await (await chat.harness.submission(submissionId!, context))!.status(context)).toMatchObject({
			status: "unanswered",
			reason: "stale",
		});
		expect((await kinds(chat.root)).at(-1)).toBe("pi.reset");
		await chat.harness.close(context);
	});

	it("does not make the conversation busy: a submission during summarization starts its run at once", async () => {
		const chat = await open();
		await history(chat);
		const summaryGate = deferred();
		const summaryReached = deferred();
		chat.faux.summaries.push(gated(summaryGate, summary(), summaryReached));
		const id = await chat.root.compact(undefined, context);
		await summaryReached.promise;
		const answerGate = deferred();
		const answerReached = deferred();
		chat.faux.agent.push(gated(answerGate, answer("a4"), answerReached));
		const input = await chat.root.submit({ type: "input", content: "u4" }, context);
		// Placed and answered immediately with the uncompacted context, not queued behind the compaction.
		expect((await input.status(context)).status).toBe("placed");
		await answerReached.promise;
		expect(userText(chat.faux.agentRequests.at(-1)!.messages[0])).toBe(text("u1", 100));
		// The summary is ready while the run is busy, so it queues and lands after the answer.
		summaryGate.resolve();
		const outcome = await result(chat, id);
		const submission = (await chat.harness.submission(
			(outcome.status === "completed" ? outcome.result.submissionId : undefined)!,
			context,
		))!;
		expect((await submission.status(context)).status).toBe("queued");
		answerGate.resolve();
		expect((await input.wait(context)).status).toBe("done");
		expect((await submission.wait(context)).status).toBe("done");
		expect((await kinds(chat.root)).slice(-3)).toEqual(["pi.user", "pi.assistant", "pi.compaction"]);
		await chat.harness.close(context);
	});

	it("counts the spend of a summary that ends stale, and writes no entry for it", async () => {
		const chat = await open();
		await history(chat);
		const input = async () =>
			(await chat.harness.snapshot(UsageDoc, chat.root.id, context))!.models["faux/faux-1"]!.input;
		const before = await input();
		const gate = deferred();
		const reached = deferred();
		chat.faux.summaries.push(gated(gate, summary(), reached));
		const id = await chat.root.compact(undefined, context);
		await reached.promise;
		await chat.root.reset(undefined, context);
		gate.resolve();
		const outcome = await result(chat, id);
		const submission = (await chat.harness.submission(
			(outcome.status === "completed" ? outcome.result.submissionId : undefined)!,
			context,
		))!;
		expect(await submission.status(context)).toMatchObject({ status: "unanswered", reason: "stale" });
		expect(await input()).toBeGreaterThan(before);
		expect((await kinds(chat.root)).includes("pi.compaction")).toBe(false);
		await chat.harness.close(context);
	});

	it("lets the compaction that cuts furthest win, whatever finishes first", async () => {
		const chat = await open();
		await history(chat);
		const first = deferred();
		const firstReached = deferred();
		chat.faux.summaries.push(gated(first, summary("FIRST"), firstReached));
		const early = await chat.root.compact(undefined, context);
		await firstReached.promise;
		await turn(chat, text("u4", 100), text("a4", 100));
		chat.faux.summaries.push(summary("SECOND"));
		const later = await result(chat, await chat.root.compact(undefined, context));
		expect(later.status).toBe("completed");
		first.resolve();
		const outcome = await result(chat, early);
		const submissionId = outcome.status === "completed" ? outcome.result.submissionId! : undefined;
		// The early compaction cut at u3, before the later cut at u4.
		expect(await (await chat.harness.submission(submissionId!, context))!.status(context)).toMatchObject({
			status: "unanswered",
			reason: "stale",
		});
		expect(userText((await chat.root.context(context)).messages[0])).toContain("SECOND");
		await chat.harness.close(context);
	});

	it("places an older-selected summary that cuts later than the newer one", async () => {
		const chat = await open();
		await history(chat);
		// A: small budget, late cut; selected first, finishes last.
		const gate = deferred();
		const reached = deferred();
		chat.faux.summaries.push(gated(gate, summary("A"), reached));
		const a = await chat.root.compact(undefined, context);
		await reached.promise;
		// B: larger budget, earlier cut; placed first.
		await chat.root.setCompaction({ ...MANUAL, keepRecentTokens: 350 }, context);
		chat.faux.summaries.push(summary("B"));
		await result(chat, await chat.root.compact(undefined, context));
		expect(userText((await chat.root.context(context)).messages[0])).toContain("B");
		gate.resolve();
		const outcome = await result(chat, a);
		const submissionId = outcome.status === "completed" ? outcome.result.submissionId! : undefined;
		expect((await (await chat.harness.submission(submissionId!, context))!.status(context)).status).toBe("done");
		const messages = (await chat.root.context(context)).messages;
		expect(userText(messages[0])).toContain("<summary>\nA\n</summary>");
		expect(messages.slice(1).map(userText)).toEqual([text("u3", 100), text("a3", 100)]);
		await chat.harness.close(context);
	});

	for (const [order, keeps, stale] of [
		["before", [150, 350], true],
		["at", [150, 150], false],
		["after", [350, 150], false],
	] as const) {
		it(`places two queued summaries in one boundary when the second cuts ${order} the first`, async () => {
			const chat = await open();
			await history(chat);
			const gate = deferred();
			const reached = deferred();
			chat.faux.agent.push(gated(gate, answer("done"), reached));
			const input = await chat.root.submit({ type: "input", content: "busy" }, context);
			await reached.promise;
			const submissions = [];
			for (const [index, keep] of keeps.entries()) {
				await chat.root.setCompaction({ ...MANUAL, keepRecentTokens: keep }, context);
				chat.faux.summaries.push(summary(`S${index}`));
				const outcome = await result(chat, await chat.root.compact(undefined, context));
				submissions.push(outcome.status === "completed" ? outcome.result.submissionId! : undefined);
			}
			gate.resolve();
			await input.wait(context);
			const statuses = [];
			for (const id of submissions)
				statuses.push((await (await chat.harness.submission(id!, context))!.wait(context)).status);
			expect(statuses).toEqual(["done", stale ? "unanswered" : "done"]);
			await chat.harness.close(context);
		});
	}

	it("is aborted by Conversation.abort(); an already queued summary survives it", async () => {
		const chat = await open();
		await history(chat);
		const reached = deferred();
		chat.faux.summaries.push(gated(deferred(), summary(), reached));
		const id = await chat.root.compact(undefined, context);
		await reached.promise;
		expect((await live(chat)).compactions).toHaveLength(1);
		await chat.root.abort(context);
		expect((await result(chat, id)).status).toBe("aborted");
		expect((await live(chat)).compactions).toBeUndefined();
		expect((await kinds(chat.root)).includes("pi.compaction")).toBe(false);

		// Queued while busy, then Esc: the queued write stays and lands with the next run's boundary.
		const gate = deferred();
		const busy = deferred();
		chat.faux.agent.push(gated(gate, answer("never"), busy));
		await chat.root.submit({ type: "input", content: "busy" }, context);
		await busy.promise;
		chat.faux.summaries.push(summary());
		const queued = await result(chat, await chat.root.compact(undefined, context));
		await chat.root.abort(context);
		const submissionId = queued.status === "completed" ? queued.result.submissionId! : undefined;
		const submission = (await chat.harness.submission(submissionId!, context))!;
		expect((await submission.status(context)).status).toBe("queued");
		expect(await submission.abort(context)).toBe("aborted");
		await turn(chat, "next", "ok");
		expect(await submission.status(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect((await kinds(chat.root)).includes("pi.compaction")).toBe(false);
		await chat.harness.close(context);
	});

	it("is ordinary work: idle waits include it", async () => {
		const chat = await open();
		await history(chat);
		const gate = deferred();
		const reached = deferred();
		chat.faux.summaries.push(gated(gate, summary(), reached));
		const id = await chat.root.compact(undefined, context);
		await reached.promise;
		let idle = false;
		const wait = chat.root.waitForIdle(context).then(() => {
			idle = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(idle).toBe(false);
		gate.resolve();
		await wait;
		expect((await chat.harness.getTask(id, context))?.state.status).toBe("terminal");
		await chat.harness.close(context);
	});

	it("enables scheduling right after open", async () => {
		const setup = chatSetup();
		const faux = script(setup);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.setCompaction({ ...MANUAL, keepRecentTokens: 10 }, context);
		const id = await root.compact(undefined, context);
		// getTask() only reads, so progress here comes from compact() itself.
		await waitFor(async () => (await harness.getTask(id, context))?.state.status === "terminal");
		expect((await harness.getTask(id, context))?.state).toMatchObject({
			outcome: { status: "completed", result: {} },
		});
		expect(faux.summaryRequests).toHaveLength(0);
		await harness.close(context);
	});
});

describe("compaction outcomes", () => {
	it("completes without a summary when there is nothing to compact", async () => {
		const chat = await open();
		await turn(chat, "hi", "hello");
		const outcome = await result(chat, await chat.root.compact(undefined, context));
		expect(outcome).toEqual({ status: "completed", result: {} });
		expect(chat.faux.summaryRequests).toHaveLength(0);
		expect((await live(chat)).compactions).toBeUndefined();
		await chat.harness.close(context);
	});

	it("asks beforeCompact: the first decision wins, a throw is reported and skipped", async () => {
		const chat = await open();
		const seen: unknown[] = [];
		chat.setup.registry.hooks.add(CompactionTask, {
			beforeCompact: () => {
				throw new Error("hook broke");
			},
		});
		chat.setup.registry.hooks.add(CompactionTask, {
			beforeCompact: (compaction) => {
				seen.push(compaction);
				return { summary: "FROM HOOK" };
			},
		});
		chat.setup.registry.hooks.add(CompactionTask, { beforeCompact: () => ({ decline: true }) });
		await history(chat);
		const outcome = await result(chat, await chat.root.compact("why", context));
		expect(outcome.status).toBe("completed");
		expect(chat.faux.summaryRequests).toHaveLength(0);
		expect(userText((await chat.root.context(context)).messages[0])).toContain("<summary>\nFROM HOOK\n</summary>");
		expect(chat.setup.reports).toEqual([expect.objectContaining({ message: "hook broke" })]);
		const compaction = seen[0] as { entries: EntryRecord[]; messages: Message[]; firstKept: number };
		expect(compaction).toMatchObject({ reason: "manual", instructions: "why" });
		expect(compaction.entries.map((record) => record.kind)).toEqual([
			"pi.user",
			"pi.system",
			"pi.assistant",
			"pi.user",
			"pi.assistant",
		]);
		expect(compaction.messages.filter((message) => message.role !== "system").map(userText)).toEqual([
			text("u1", 100),
			text("a1", 100),
			text("u2", 100),
			text("a2", 100),
		]);
		await chat.harness.close(context);
	});

	it("completes without a summary when a hook declines", async () => {
		const chat = await open();
		chat.setup.registry.hooks.add(CompactionTask, { beforeCompact: () => ({ decline: true }) });
		await history(chat);
		expect(await result(chat, await chat.root.compact(undefined, context))).toEqual({
			status: "completed",
			result: {},
		});
		expect(chat.faux.summaryRequests).toHaveLength(0);
		await chat.harness.close(context);
	});

	it("fails with no_model without a configured model", async () => {
		const chat = await open();
		await history(chat);
		await chat.root.setModel(undefined, context);
		const outcome = await result(chat, await chat.root.compact(undefined, context));
		expect(outcome).toMatchObject({ status: "failed", error: { detail: { reason: "no_model" } } });
		expect((await live(chat)).compactions).toBeUndefined();
		await chat.harness.close(context);
	});

	/** Input tokens a compaction added to the ledger. */
	async function compactionInput(chat: Chat, run: () => Promise<unknown>): Promise<number> {
		const input = async () =>
			(await chat.harness.snapshot(UsageDoc, chat.root.id, context))!.models["faux/faux-1"]!.input;
		const before = await input();
		await run();
		return (await input()) - before;
	}

	it("retries a retryable error with the pinned request and counts every attempt once", async () => {
		const single = await open();
		await history(single);
		await single.root.setThinkingLevel("high", context);
		single.faux.summaries.push(summary());
		const once = await compactionInput(single, async () =>
			result(single, await single.root.compact(undefined, context)),
		);
		expect(once).toBeGreaterThan(0);
		await single.harness.close(context);

		const chat = await open();
		await history(chat);
		await chat.root.setThinkingLevel("high", context);
		await chat.root.setStreamOptions({ timeoutMs: 1234, deferred: true }, context);
		chat.faux.summaries.push(async () => {
			// Changed during the attempt: the retry still uses the pinned request.
			await chat.root.setThinkingLevel("low", context);
			await chat.root.setStreamOptions({ timeoutMs: 1 }, context);
			return failure("overloaded");
		});
		chat.faux.summaries.push(summary());
		const twice = await compactionInput(chat, async () => {
			expect((await result(chat, await chat.root.compact(undefined, context))).status).toBe("completed");
		});
		expect(chat.faux.summaryRequests).toHaveLength(2);
		expect(twice).toBe(2 * once);
		for (const request of chat.faux.summaryRequests) {
			expect(request.options).toMatchObject({ reasoning: "high", timeoutMs: 1234, cacheRetention: "none" });
			expect(request.options?.deferred).toBeUndefined();
		}
		await chat.harness.close(context);
	});

	it("adds no usage when a hook declines or supplies the summary", async () => {
		for (const decision of [{ decline: true } as const, { summary: "HOOK" }]) {
			const chat = await open();
			chat.setup.registry.hooks.add(CompactionTask, { beforeCompact: () => decision });
			await history(chat);
			expect(
				await compactionInput(chat, async () => result(chat, await chat.root.compact(undefined, context))),
			).toBe(0);
			await chat.harness.close(context);
		}
	});

	it("caps maxTokens at the model's output limit and sends no tools", async () => {
		const chat = await open();
		chat.setup.registry.tools.add({
			name: "read",
			description: "read",
			parameters: Type.Object({}),
			execute: async () => ({ content: [] }),
		});
		await chat.root.setActiveTools(["read"], context);
		await history(chat);
		await chat.root.setCompaction({ ...MANUAL, reserveTokens: 2000 }, context);
		chat.faux.summaries.push(summary());
		await result(chat, await chat.root.compact(undefined, context));
		const request = chat.faux.summaryRequests[0]!;
		// 0.8 * 2000 = 1600, above the model's 900.
		expect(request.options?.maxTokens).toBe(900);
		expect(request.messages).toHaveLength(2);
		expect(request.messages.some((message) => message.role === "system" && message.toolsAdded !== undefined)).toBe(
			false,
		);
		await chat.harness.close(context);
	});

	for (const [name, response, message] of [
		["retries run out", failure("overloaded"), "Summarization failed: overloaded"],
		["a non-retryable error", failure("bad request"), "Summarization failed: bad request"],
		[
			"a length stop",
			fauxAssistantMessage("partial", { stopReason: "length" }),
			"Summarization hit the token limit; the summary is incomplete",
		],
		[
			"a tool call",
			fauxAssistantMessage([fauxToolCall("read", {})], { stopReason: "stop" }),
			"Summarization attempted to call a tool",
		],
		["empty text", answer("  "), "Summarization produced no text"],
	] as const) {
		it(`fails with model_error on ${name}`, async () => {
			const chat = await open();
			await history(chat);
			for (let index = 0; index < 3; index++) chat.faux.summaries.push(response);
			const outcome = await result(chat, await chat.root.compact(undefined, context));
			expect(outcome).toMatchObject({ status: "failed", error: { message, detail: { reason: "model_error" } } });
			// The retry policy allows two retries after the first attempt.
			expect(chat.faux.summaryRequests).toHaveLength(name === "retries run out" ? 3 : 1);
			expect((await live(chat)).compactions).toBeUndefined();
			expect((await kinds(chat.root)).includes("pi.compaction")).toBe(false);
			await chat.harness.close(context);
		});
	}
});

// ─── Automatic compaction ─────────────────────────────────────────────────

/** Background threshold at 500 and blocking threshold at 1500 tokens of a 2000-token window. */
const BACKGROUND: CompactionPolicy = {
	enabled: true,
	reserveTokens: 500,
	keepRecentTokens: 150,
	backgroundTokens: 1000,
};
/** Blocking threshold at 700 tokens of a 1000-token window, no background compaction. */
const BLOCKING: CompactionPolicy = { enabled: true, reserveTokens: 300, keepRecentTokens: 150, backgroundTokens: 0 };

async function compactionTasks(chat: Chat) {
	const inspection = await chat.harness.inspect(context);
	return inspection.tasks.map((task) => task.record).filter((record) => record.kind === "pi.compaction");
}

describe("background threshold compaction", () => {
	it("starts above the background threshold without blocking the run; idle waits and Esc ignore it", async () => {
		const chat = await open({ contextWindow: 2000 });
		await history(chat);
		await chat.root.setCompaction(BACKGROUND, context);
		const gate = deferred();
		const reached = deferred();
		chat.faux.summaries.push(gated(gate, summary(), reached));
		await turn(chat, text("u4", 100), text("a4", 100));
		await reached.promise;
		const [task] = await compactionTasks(chat);
		expect(task).toMatchObject({ background: true, input: { reason: "threshold" } });
		expect(task!.owner).toBeUndefined();
		expect((await live(chat)).compactions).toEqual([
			{ taskId: task!.id, reason: "threshold", blocking: false, attempt: 1 },
		]);
		// Background work: neither conversation idle nor Esc waits for or stops it.
		await chat.root.waitForIdle(context);
		await chat.root.abort(context);
		expect((await chat.harness.getTask(task!.id, context))?.state.status).toBe("running");
		gate.resolve();
		const outcome = await result(chat, task!.id as TaskId<CompactionResult>);
		expect(outcome.status).toBe("completed");
		expect((await kinds(chat.root)).at(-1)).toBe("pi.compaction");
		expect(userText((await chat.root.context(context)).messages[0])).toContain("SUMMARY");
		await chat.harness.close(context);
	});

	for (const [name, policy] of [
		["disabled", { ...BACKGROUND, enabled: false }],
		["backgroundTokens is 0", { ...BACKGROUND, backgroundTokens: 0 }],
		["there is no cut", { ...BACKGROUND, keepRecentTokens: 100_000 }],
	] as const) {
		it(`does not start when ${name}`, async () => {
			const chat = await open({ contextWindow: 2000 });
			await history(chat);
			await chat.root.setCompaction(policy, context);
			await turn(chat, text("u4", 100), text("a4", 100));
			expect(await compactionTasks(chat)).toEqual([]);
			expect(chat.faux.summaryRequests).toHaveLength(0);
			await chat.harness.close(context);
		});
	}

	it("does not start while another compaction is listed", async () => {
		const chat = await open({ contextWindow: 2000 });
		await history(chat);
		const reached = deferred();
		chat.faux.summaries.push(gated(deferred(), summary(), reached));
		const manual = await chat.root.compact(undefined, context);
		await reached.promise;
		await chat.root.setCompaction(BACKGROUND, context);
		await turn(chat, text("u4", 100), text("a4", 100));
		expect((await compactionTasks(chat)).map((task) => task.id)).toEqual([manual]);
		await chat.harness.abortTask(manual, context);
		await chat.harness.close(context);
	});

	it("stops through abortTask() and Conversation.abort() with background", async () => {
		for (const stop of ["task", "conversation"] as const) {
			const chat = await open({ contextWindow: 2000 });
			await history(chat);
			await chat.root.setCompaction(BACKGROUND, context);
			const reached = deferred();
			chat.faux.summaries.push(gated(deferred(), summary(), reached));
			await turn(chat, text("u4", 100), text("a4", 100));
			await reached.promise;
			const [task] = await compactionTasks(chat);
			if (stop === "task") await chat.harness.abortTask(task!.id, context);
			else await chat.root.abort(context, { background: true });
			expect((await result(chat, task!.id as TaskId<CompactionResult>)).status).toBe("aborted");
			expect((await live(chat)).compactions).toBeUndefined();
			await chat.harness.close(context);
		}
	});
});

describe("blocking threshold compaction", () => {
	it("waits for its compaction, which appends the summary before the request", async () => {
		const chat = await open({ contextWindow: 1000 });
		await history(chat);
		await chat.root.setCompaction(BLOCKING, context);
		// A new section: preparation has a system entry to append, but must not append it before the wait.
		chat.setup.registry.systemPrompt.section("extra", () => "EXTRA");
		const gate = deferred();
		const reached = deferred();
		chat.faux.summaries.push(gated(gate, summary(), reached));
		chat.faux.agent.push(answer("a4"));
		const input = await chat.root.submit({ type: "input", content: text("u4", 200) }, context);
		await reached.promise;
		const [child] = await compactionTasks(chat);
		const generation = (await live(chat)).run!.taskId;
		expect(child).toMatchObject({ owner: generation, background: false, input: { reason: "threshold" } });
		expect((await chat.harness.getTask(generation, context))?.state).toMatchObject({
			status: "waiting",
			on: [child!.id],
			checkpoint: { phase: "prepare", attempt: 1, compacted: child!.id },
		});
		expect((await live(chat)).compactions).toEqual([
			{ taskId: child!.id, reason: "threshold", blocking: true, attempt: 1 },
		]);
		// Nothing was appended before the wait.
		expect((await kinds(chat.root)).at(-1)).toBe("pi.user");
		gate.resolve();
		expect((await input.wait(context)).status).toBe("done");
		expect((await result(chat, child!.id as TaskId<CompactionResult>)).status).toBe("completed");
		expect((await kinds(chat.root)).slice(-3)).toEqual(["pi.compaction", "pi.system", "pi.assistant"]);
		const request = chat.faux.agentRequests.at(-1)!.messages;
		expect(userText(request[0])).toContain("SUMMARY");
		const systems = request.filter((message) => message.role === "system");
		expect(systems).toHaveLength(1);
		expect(systems[0]).toMatchObject({
			sections: { preamble: "You are helpful.", extra: "<extra>\nEXTRA\n</extra>" },
		});
		await chat.harness.close(context);
	});

	it("sends the request once, without a second compaction, when the kept part is still above the threshold", async () => {
		const chat = await open({ contextWindow: 1000 });
		await history(chat);
		await chat.root.setCompaction({ ...BLOCKING, keepRecentTokens: 700 }, context);
		chat.faux.summaries.push(summary());
		await turn(chat, text("u4", 400), "a4");
		expect(chat.faux.summaryRequests).toHaveLength(1);
		expect((await kinds(chat.root)).filter((kind) => kind === "pi.compaction")).toHaveLength(1);
		await chat.harness.close(context);
	});

	for (const [name, prepare] of [
		[
			"declines",
			(chat: Chat) => chat.setup.registry.hooks.add(CompactionTask, { beforeCompact: () => ({ decline: true }) }),
		],
		["fails", (chat: Chat) => chat.faux.summaries.push(failure("bad request"))],
	] as const) {
		it(`sends the request anyway when its compaction ${name}`, async () => {
			const chat = await open({ contextWindow: 1000 });
			await history(chat);
			await chat.root.setCompaction(BLOCKING, context);
			prepare(chat);
			await turn(chat, text("u4", 200), "a4");
			expect((await kinds(chat.root)).includes("pi.compaction")).toBe(false);
			expect(userText(chat.faux.agentRequests.at(-1)!.messages[0])).toBe(text("u1", 100));
			await chat.harness.close(context);
		});
	}

	it("sends the request anyway when its compaction is aborted directly", async () => {
		const chat = await open({ contextWindow: 1000 });
		await history(chat);
		await chat.root.setCompaction(BLOCKING, context);
		const reached = deferred();
		chat.faux.summaries.push(gated(deferred(), summary(), reached));
		chat.faux.agent.push(answer("a4"));
		const input = await chat.root.submit({ type: "input", content: text("u4", 200) }, context);
		await reached.promise;
		const [child] = await compactionTasks(chat);
		await chat.harness.abortTask(child!.id, context);
		expect((await input.wait(context)).status).toBe("done");
		expect((await kinds(chat.root)).includes("pi.compaction")).toBe(false);
		await chat.harness.close(context);
	});

	it("is aborted with its generation by Esc, before the generation's abort handler", async () => {
		const chat = await open({ contextWindow: 1000 });
		await history(chat);
		await chat.root.setCompaction(BLOCKING, context);
		const reached = deferred();
		chat.faux.summaries.push(gated(deferred(), summary(), reached));
		const events: AgentEvent[] = [];
		const stream = await watchEvents(chat.harness, chat.root.id, context);
		stream.start(async (batch) => {
			events.push(...batch);
		});
		const input = await chat.root.submit({ type: "input", content: text("u4", 200) }, context);
		await reached.promise;
		const [child] = await compactionTasks(chat);
		await chat.root.abort(context);
		expect(await input.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect((await chat.harness.getTask(child!.id, context))?.state).toMatchObject({ outcome: { status: "aborted" } });
		await waitFor(() => events.some((event) => event.type === "run_end"));
		const types = events.map((event) => event.type);
		expect(types.indexOf("compaction_end")).toBeLessThan(types.indexOf("run_end"));
		await stream.stop();
		await chat.harness.close(context);
	});

	it("wins over a background compaction still in flight, which then settles stale", async () => {
		const chat = await open({ contextWindow: 2000 });
		await history(chat);
		await chat.root.setCompaction(BACKGROUND, context);
		const gate = deferred();
		const reached = deferred();
		chat.faux.summaries.push(gated(gate, summary("BACKGROUND"), reached));
		await turn(chat, text("u4", 100), text("a4", 100));
		await reached.promise;
		const [background] = await compactionTasks(chat);
		chat.faux.summaries.push(summary("BLOCKING"));
		await turn(chat, text("u5", 1000), "a5");
		expect(userText((await chat.root.context(context)).messages[0])).toContain("BLOCKING");
		gate.resolve();
		const outcome = await result(chat, background!.id as TaskId<CompactionResult>);
		const submissionId = outcome.status === "completed" ? outcome.result.submissionId! : undefined;
		expect(await (await chat.harness.submission(submissionId!, context))!.status(context)).toMatchObject({
			status: "unanswered",
			reason: "stale",
		});
		await chat.harness.close(context);
	});
});

describe("overflow compaction", () => {
	const ENABLED: CompactionPolicy = { ...MANUAL, enabled: true };

	it("compacts and retries with the same attempt, leaving the error out of the retry", async () => {
		const chat = await open();
		await history(chat);
		await chat.root.setCompaction(ENABLED, context);
		chat.faux.summaries.push(summary());
		let attempt: number | undefined;
		chat.faux.agent.push(failure(OVERFLOW));
		chat.faux.agent.push(async () => {
			attempt = (await live(chat)).generation?.attempt;
			return answer("fits");
		});
		const input = await chat.root.submit({ type: "input", content: text("u4", 100) }, context);
		expect((await input.wait(context)).status).toBe("done");
		expect(attempt).toBe(1);
		expect((await kinds(chat.root)).slice(-5)).toEqual([
			"pi.user",
			"pi.assistant",
			"pi.compaction",
			"pi.system",
			"pi.assistant",
		]);
		const [compaction] = (await allEntries(chat.root)).filter((record) => record.kind === "pi.compaction");
		expect(compaction).toMatchObject({ data: { reason: "overflow" } });
		const retry = chat.faux.agentRequests.at(-1)!.messages;
		expect(userText(retry[0])).toContain("SUMMARY");
		expect(retry.some((message) => message.role === "assistant" && message.stopReason === "error")).toBe(false);
		await chat.harness.close(context);
	});

	it("fails a second overflow with its error entry", async () => {
		const chat = await open();
		await history(chat);
		await chat.root.setCompaction(ENABLED, context);
		chat.faux.summaries.push(summary());
		chat.faux.agent.push(failure(OVERFLOW), failure(OVERFLOW));
		const input = await chat.root.submit({ type: "input", content: text("u4", 100) }, context);
		expect(await input.wait(context)).toMatchObject({
			status: "unanswered",
			reason: "model_error",
			detail: OVERFLOW,
		});
		expect((await kinds(chat.root)).filter((kind) => kind === "pi.compaction")).toHaveLength(1);
		expect((await kinds(chat.root)).at(-1)).toBe("pi.assistant");
		await chat.harness.close(context);
	});

	it("fails without compacting when compaction is disabled, even for a retryable-looking overflow", async () => {
		const chat = await open();
		await history(chat);
		chat.faux.agent.push(failure(`overloaded: ${OVERFLOW}`));
		const input = await chat.root.submit({ type: "input", content: text("u4", 100) }, context);
		expect(await input.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
		expect(chat.faux.agentRequests).toHaveLength(4);
		expect(chat.faux.summaryRequests).toHaveLength(0);
		await chat.harness.close(context);
	});

	it("fails after a blocking threshold compaction in the same generation", async () => {
		const chat = await open({ contextWindow: 1000 });
		await history(chat);
		await chat.root.setCompaction(BLOCKING, context);
		chat.faux.summaries.push(summary());
		chat.faux.agent.push(failure(OVERFLOW));
		const input = await chat.root.submit({ type: "input", content: text("u4", 200) }, context);
		expect(await input.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
		expect(chat.faux.summaryRequests).toHaveLength(1);
		await chat.harness.close(context);
	});

	for (const [name, prepare, requests] of [
		[
			"declines",
			(chat: Chat) => chat.setup.registry.hooks.add(CompactionTask, { beforeCompact: () => ({ decline: true }) }),
			0,
		],
		["fails", (chat: Chat) => chat.faux.summaries.push(failure("bad request")), 1],
		// Classification finds no cut, so no compaction starts and the ordinary failure carries the text.
		["cannot cut", (chat: Chat) => chat.root.setCompaction({ ...ENABLED, keepRecentTokens: 100_000 }, context), 0],
	] as const) {
		it(`fails with the overflow text when compaction ${name}`, async () => {
			const chat = await open();
			await turn(chat, text("u1", 100), text("a1", 100));
			await chat.root.setCompaction(ENABLED, context);
			await prepare(chat);
			chat.faux.agent.push(failure(OVERFLOW));
			const input = await chat.root.submit({ type: "input", content: text("u4", 100) }, context);
			expect(await input.wait(context)).toMatchObject({
				status: "unanswered",
				reason: "model_error",
				detail: OVERFLOW,
			});
			expect(chat.faux.summaryRequests).toHaveLength(requests);
			await chat.harness.close(context);
		});
	}
});

describe("compaction estimates and interactions", () => {
	for (const clock of ["real", "fixed"] as const) {
		it(`ignores usage measured before a summary placed mid-run (${clock} clock)`, async () => {
			const setup = chatSetup({ models: [{ id: "faux-1", contextWindow: 2000, maxTokens: 900 }] });
			if (clock === "fixed") setup.now = () => 1_000;
			const chat = await open({ contextWindow: 2000 }, setup);
			const toolGate = deferred();
			const toolReached = deferred();
			chat.setup.registry.tools.add({
				name: "slow",
				description: "slow",
				parameters: Type.Object({}),
				execute: async () => {
					toolReached.resolve();
					await toolGate.promise;
					return { content: [{ type: "text", text: text("result", 200) }] };
				},
			});
			await chat.root.setActiveTools(["slow"], context);
			await turn(chat, text("u1", 220), text("a1", 220));
			await turn(chat, text("u2", 220), text("a2", 220));
			await turn(chat, text("u3", 220), text("a3", 220));
			// Background at 900, blocking at 1500: the tool call's usage plus its result would cross 1500.
			await chat.root.setCompaction({ ...BACKGROUND, backgroundTokens: 600 }, context);
			// The request starts a background compaction; its tool call's usage measures the whole context.
			chat.faux.agent.push(fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" }));
			chat.faux.agent.push(answer("done"));
			const summaryGate = deferred();
			const summaryReached = deferred();
			chat.faux.summaries.push(gated(summaryGate, summary(), summaryReached));
			const input = await chat.root.submit({ type: "input", content: text("u4", 50) }, context);
			await Promise.all([toolReached.promise, summaryReached.promise]);
			const [background] = await compactionTasks(chat);
			summaryGate.resolve();
			// Queued: the run is busy in its tool round.
			const queued = await result(chat, background!.id as TaskId<CompactionResult>);
			const submissionId = queued.status === "completed" ? queued.result.submissionId! : undefined;
			expect((await (await chat.harness.submission(submissionId!, context))!.status(context)).status).toBe("queued");
			toolGate.resolve();
			expect((await input.wait(context)).status).toBe("done");
			// The summary landed at postTools; the successor saw a small context and did not compact again.
			expect(chat.faux.summaryRequests).toHaveLength(1);
			expect(await compactionTasks(chat)).toEqual([]);
			expect(userText(chat.faux.agentRequests.at(-1)!.messages[0])).toContain("SUMMARY");
			await chat.harness.close(context);
		});
	}

	it("rebaselines the system prompt over kept system deltas", async () => {
		const chat = await open();
		let mood = "cheerful";
		chat.setup.registry.systemPrompt.section("mood", () => mood, { tag: false });
		await turn(chat, text("u1", 100), text("a1", 100));
		await turn(chat, text("u2", 100), text("a2", 100));
		mood = "terse";
		await turn(chat, text("u3", 100), text("a3", 100));
		await chat.root.setCompaction({ ...MANUAL, keepRecentTokens: 250 }, context);
		chat.faux.summaries.push(summary());
		await result(chat, await chat.root.compact(undefined, context));
		// The kept range holds the delta for the terse mood; the next request has one complete baseline.
		expect((await chat.root.context(context)).entries.some((record) => record.kind === "pi.system")).toBe(true);
		await turn(chat, "next", "ok");
		const systems = chat.faux.agentRequests.at(-1)!.messages.filter((message) => message.role === "system");
		expect(systems).toHaveLength(1);
		expect(systems[0]).toMatchObject({ sections: { preamble: "You are helpful.", mood: "terse" } });
		await chat.harness.close(context);
	});

	it("summarizes a replaced entry's replacement and shows it to the hook", async () => {
		const chat = await open();
		await history(chat);
		const [u1] = await allEntries(chat.root);
		await chat.root.submit(
			{
				type: "write",
				entry: {
					kind: "app.redact",
					edits: [
						{
							target: u1!.id,
							action: "replace",
							messages: [{ role: "user", content: "REDACTED", timestamp: 0 }],
						},
					],
				},
			},
			context,
		);
		let messages: readonly Message[] = [];
		chat.setup.registry.hooks.add(CompactionTask, {
			beforeCompact: (compaction) => {
				messages = compaction.messages;
				return undefined;
			},
		});
		chat.faux.summaries.push(summary());
		await result(chat, await chat.root.compact(undefined, context));
		expect(userText(messages[0])).toBe("REDACTED");
		expect(userText(chat.faux.summaryRequests[0]!.messages[1])).toContain("[User]: REDACTED");
		await chat.harness.close(context);
	});

	it("compacts a fork whose cut falls on a parent entry", async () => {
		const chat = await open();
		await history(chat);
		const entries = await allEntries(chat.root);
		const fork = await chat.root.fork(entries.at(-1)!.id, { ownership: { kind: "ownerless" } }, context);
		chat.faux.summaries.push(summary());
		const outcome = await result(chat, await fork.compact(undefined, context));
		const submissionId = outcome.status === "completed" ? outcome.result.submissionId! : undefined;
		expect((await (await chat.harness.submission(submissionId!, context))!.wait(context)).status).toBe("done");
		const u3 = entries.find((record) => userText(record.model?.[0]).startsWith("u3"))!;
		const view = await fork.context(context);
		expect(view.head).toMatchObject({ kind: "pi.compaction", head: u3.id, conversationId: fork.id });
		expect(view.messages.slice(1).map(userText)).toEqual([text("u3", 100), text("a3", 100)]);
		// The parent is untouched.
		expect((await kinds(chat.root)).includes("pi.compaction")).toBe(false);
		// The fork's view keeps the parent entries the summary kept.
		const state = await fork.viewState(context);
		expect(state.value.entries).toEqual(view.entries);
		state.dispose();
		await chat.harness.close(context);
	});

	it("settles stale in a fork reset while it summarizes", async () => {
		const chat = await open();
		await history(chat);
		const entries = await allEntries(chat.root);
		const fork = await chat.root.fork(entries.at(-1)!.id, { ownership: { kind: "ownerless" } }, context);
		const gate = deferred();
		const reached = deferred();
		chat.faux.summaries.push(gated(gate, summary(), reached));
		const id = await fork.compact(undefined, context);
		await reached.promise;
		await fork.reset(undefined, context);
		gate.resolve();
		const outcome = await result(chat, id);
		const submission = (await chat.harness.submission(
			(outcome.status === "completed" ? outcome.result.submissionId : undefined)!,
			context,
		))!;
		expect(await submission.status(context)).toMatchObject({ status: "unanswered", reason: "stale" });
		expect((await fork.context(context)).head?.kind).toBe("pi.reset");
		await chat.harness.close(context);
	});

	it("places an older queued summary and the current one together when idle admission drains the inbox", async () => {
		const chat = await open();
		await history(chat);
		const gate = deferred();
		const reached = deferred();
		chat.faux.agent.push(gated(gate, failure("bad request"), reached));
		const failed = await chat.root.submit({ type: "input", content: "fails" }, context);
		await reached.promise;
		chat.faux.summaries.push(summary("OLDER"));
		const older = await result(chat, await chat.root.compact(undefined, context));
		gate.resolve();
		await failed.wait(context);
		// Idle now, with the older summary still queued; the current one queues behind it and a final boundary runs.
		chat.faux.summaries.push(summary("CURRENT"));
		const current = await result(chat, await chat.root.compact(undefined, context));
		const statuses = [];
		for (const outcome of [older, current]) {
			const id = outcome.status === "completed" ? outcome.result.submissionId! : undefined;
			statuses.push((await (await chat.harness.submission(id!, context))!.status(context)).status);
		}
		expect(statuses).toEqual(["done", "done"]);
		expect(userText((await chat.root.context(context)).messages[0])).toContain("CURRENT");
		await chat.harness.close(context);
	});

	it("places a hook's summary and holds while work the hook created runs", async () => {
		const chat = await open();
		const childGate = deferred();
		const Child = defineChildTask(childGate);
		chat.setup.registry.tasks.add(Child);
		chat.setup.registry.hooks.add(CompactionTask, {
			beforeCompact: async (_compaction, api, hookContext) => {
				await chat.harness.commit(async (tx) => {
					await tx.createTask(
						Child,
						{},
						{ ownership: { kind: "task", taskId: api.taskId }, conversationId: chat.root.id },
					);
				}, hookContext);
				return { summary: "HOOK" };
			},
		});
		await history(chat);
		const id = await chat.root.compact(undefined, context);
		await waitFor(async () => (await chat.harness.getTask(id, context))?.state.status === "completing");
		// The summary and the status removal landed at the hold.
		expect((await kinds(chat.root)).at(-1)).toBe("pi.compaction");
		expect((await live(chat)).compactions).toBeUndefined();
		childGate.resolve();
		expect((await result(chat, id)).status).toBe("completed");
		await chat.harness.close(context);
	});

	it("removes the status of a faulted compaction", async () => {
		const chat = await open();
		await history(chat);
		const getModel = chat.setup.models.getModel.bind(chat.setup.models);
		chat.setup.models.getModel = () => {
			throw new Error("models broke");
		};
		const outcome = await result(chat, await chat.root.compact(undefined, context));
		chat.setup.models.getModel = getModel;
		expect(outcome).toMatchObject({ status: "faulted", error: { message: "models broke" } });
		expect((await live(chat)).compactions).toBeUndefined();
		await chat.harness.close(context);
	});
});

function defineChildTask(gate: Deferred) {
	return defineTask<Record<string, never>, { phase: "run" }, null>({
		name: "test.child",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (_task, runtime, taskContext) => {
				await gate.promise;
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
					taskContext,
				);
			},
		},
		abort: async (_task, runtime, taskContext) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
		},
	});
}

describe("compaction events and live status", () => {
	it("reports start and end, and the retry backoff in a late joiner's snapshot", async () => {
		const chat = await open();
		await history(chat);
		await chat.root.setRetryPolicy({ enabled: true, maxRetries: 2, baseDelayMs: 60_000 }, context);
		const events: AgentEvent[] = [];
		const stream = await watchEvents(chat.harness, chat.root.id, context);
		stream.start(async (batch) => {
			events.push(...batch);
		});
		chat.faux.summaries.push(failure("overloaded"));
		const id = await chat.root.compact(undefined, context);
		await waitFor(async () => (await live(chat)).compactions?.[0]?.retry !== undefined);
		const late = await watchEvents(chat.harness, chat.root.id, context);
		expect(late.snapshot.compactions).toEqual([
			{
				taskId: id,
				reason: "manual",
				blocking: false,
				attempt: 1,
				retry: { at: expect.any(Number), error: "overloaded" },
			},
		]);
		await late.stop();
		await chat.harness.abortTask(id, context);
		await waitFor(() => events.some((event) => event.type === "compaction_end"));
		expect(events.filter((event) => event.type.startsWith("compaction_"))).toEqual([
			{ type: "compaction_start", taskId: id, reason: "manual", blocking: false },
			{ type: "compaction_end", taskId: id, reason: "manual" },
		]);
		await stream.stop();
		await chat.harness.close(context);
	});

	it("lists concurrent compactions in task ID order", async () => {
		const chat = await open();
		await history(chat);
		const first = deferred();
		const second = deferred();
		chat.faux.summaries.push(gated(deferred(), summary(), first), gated(deferred(), summary(), second));
		const a = await chat.root.compact(undefined, context);
		const b = await chat.root.compact(undefined, context);
		await Promise.all([first.promise, second.promise]);
		expect((await live(chat)).compactions?.map((status) => status.taskId)).toEqual([a, b]);
		await chat.root.abort(context);
		expect((await live(chat)).compactions).toBeUndefined();
		await chat.harness.close(context);
	});
});

// ─── Recovery ─────────────────────────────────────────────────────────────

describe("compaction recovery", () => {
	async function reopen(path: string, setup: ChatSetup, faux: Script): Promise<Chat> {
		const { harness, root } = await openChat(await openNodeSqliteStorage(path), setup);
		harness.resume();
		return { harness, root, setup, faux };
	}

	async function first(path: string) {
		const setup = chatSetup();
		setup.registry.systemPrompt.section("preamble", () => "You are helpful.", { tag: false });
		const faux = script(setup);
		const { harness, root } = await openChat(await openNodeSqliteStorage(path), setup);
		await root.setCompaction(MANUAL, context);
		await root.setRetryPolicy({ enabled: true, maxRetries: 2, baseDelayMs: 1 }, context);
		harness.resume();
		const chat = { harness, root, setup, faux };
		await history(chat);
		return chat;
	}

	it("repeats nothing after reopen once the summary is placed", async () => {
		const path = await sqlitePath();
		let chat = await first(path);
		chat.faux.summaries.push(summary());
		await result(chat, await chat.root.compact(undefined, context));
		const entries = await allEntries(chat.root);
		const usage = await chat.harness.snapshot(UsageDoc, chat.root.id, context);
		await chat.harness.close(context);
		chat = await reopen(path, chat.setup, chat.faux);
		await chat.harness.waitForIdle(context);
		expect(chat.faux.summaryRequests).toHaveLength(1);
		expect(await allEntries(chat.root)).toEqual(entries);
		expect(await chat.harness.snapshot(UsageDoc, chat.root.id, context)).toEqual(usage);
		const inspection = await chat.harness.inspect(context);
		expect([inspection.tasks, inspection.submissions]).toEqual([[], []]);
		await chat.harness.close(context);
	});

	it("fails an overflow run with its text when its compaction fails after reopen", async () => {
		const path = await sqlitePath();
		let chat = await first(path);
		await chat.root.setCompaction({ ...MANUAL, enabled: true }, context);
		const reached = deferred();
		chat.faux.summaries.push(gated(deferred(), summary(), reached));
		chat.faux.agent.push(failure(OVERFLOW));
		const input = await chat.root.submit({ type: "input", content: text("u4", 100) }, context);
		await reached.promise;
		const generation = (await live(chat)).run!.taskId;
		expect((await chat.harness.getTask(generation, context))?.state).toMatchObject({
			status: "waiting",
			checkpoint: { phase: "prepare", overflow: OVERFLOW },
		});
		await chat.harness.close(context);
		chat = await reopen(path, chat.setup, chat.faux);
		chat.faux.summaries.push(failure("bad request"));
		const settled = await (await chat.harness.submission(input.id, context))!.wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "model_error", detail: OVERFLOW });
		await chat.harness.close(context);
	});

	it("reruns select and its hook after a crash in select", async () => {
		const path = await sqlitePath();
		let chat = await first(path);
		let calls = 0;
		const reached = deferred();
		chat.setup.registry.hooks.add(CompactionTask, {
			beforeCompact: async (_compaction, _api, hookContext) => {
				calls++;
				if (calls === 1) {
					reached.resolve();
					await aborted(hookContext.abortSignal!);
				}
				return undefined;
			},
		});
		const id = await chat.root.compact(undefined, context);
		await reached.promise;
		await chat.harness.close(context);
		chat = await reopen(path, chat.setup, chat.faux);
		chat.faux.summaries.push(summary());
		expect((await result(chat, id)).status).toBe("completed");
		expect(calls).toBe(2);
		await chat.harness.close(context);
	});

	it("resends an interrupted summarization once and counts only the answered attempt", async () => {
		const path = await sqlitePath();
		let chat = await first(path);
		const reached = deferred();
		chat.faux.summaries.push(gated(deferred(), summary(), reached));
		const id = await chat.root.compact(undefined, context);
		await reached.promise;
		const usageBefore = (await chat.harness.snapshot(UsageDoc, chat.root.id, context))!.models["faux/faux-1"]!;
		expect((await chat.harness.getTask(id, context))?.state).toMatchObject({ checkpoint: { phase: "summarize" } });
		await chat.harness.close(context);
		chat = await reopen(path, chat.setup, chat.faux);
		chat.faux.summaries.push(summary());
		expect((await result(chat, id)).status).toBe("completed");
		expect(chat.faux.summaryRequests).toHaveLength(2);
		const [, resent] = chat.faux.summaryRequests;
		expect(resent!.messages).toEqual(
			chat.faux.summaryRequests[0]!.messages.map((message) => ({ ...message, timestamp: expect.any(Number) })),
		);
		const usage = (await chat.harness.snapshot(UsageDoc, chat.root.id, context))!.models["faux/faux-1"]!;
		expect(usage.input).toBeGreaterThan(usageBefore.input);
		expect(usage.output - usageBefore.output).toBe(2);
		await chat.harness.close(context);
	});

	it("resumes a retry backoff after reopen", async () => {
		const path = await sqlitePath();
		let chat = await first(path);
		let now = Date.now();
		chat.setup.now = () => now;
		await chat.root.setRetryPolicy({ enabled: true, maxRetries: 2, baseDelayMs: 60_000 }, context);
		chat.faux.summaries.push(failure("overloaded"));
		const id = await chat.root.compact(undefined, context);
		await waitFor(async () => (await live(chat)).compactions?.[0]?.retry !== undefined);
		expect((await chat.harness.getTask(id, context))?.state).toMatchObject({
			checkpoint: { phase: "retry", attempt: 1 },
		});
		await chat.harness.close(context);
		now += 120_000;
		chat = await reopen(path, chat.setup, chat.faux);
		chat.faux.summaries.push(summary());
		expect((await result(chat, id)).status).toBe("completed");
		expect(chat.faux.summaryRequests).toHaveLength(2);
		await chat.harness.close(context);
	});

	it("keeps a generation waiting on its blocking compaction across reopen", async () => {
		const path = await sqlitePath();
		let chat = await first(path);
		const setup = chat.setup;
		const reached = deferred();
		chat.faux.summaries.push(gated(deferred(), summary(), reached));
		// The faux model window is 128k; this blocking threshold needs a small context window.
		await chat.root.setCompaction({ ...BLOCKING, reserveTokens: 128_000 - 700 }, context);
		const input = await chat.root.submit({ type: "input", content: text("u4", 200) }, context);
		await reached.promise;
		await chat.harness.close(context);
		chat = await reopen(path, setup, chat.faux);
		chat.faux.summaries.push(summary());
		chat.faux.agent.push(answer("a4"));
		expect((await (await chat.harness.submission(input.id, context))!.wait(context)).status).toBe("done");
		expect((await kinds(chat.root)).slice(-3)).toEqual(["pi.compaction", "pi.system", "pi.assistant"]);
		await chat.harness.close(context);
	});

	it("keeps a queued summary across reopen and places it at the next boundary", async () => {
		const path = await sqlitePath();
		let chat = await first(path);
		const reached = deferred();
		chat.faux.agent.push(gated(deferred(), answer("never"), reached));
		const input = await chat.root.submit({ type: "input", content: "busy" }, context);
		await reached.promise;
		chat.faux.summaries.push(summary());
		const outcome = await result(chat, await chat.root.compact(undefined, context));
		await chat.harness.close(context);
		chat = await reopen(path, chat.setup, chat.faux);
		chat.faux.agent.push(answer("answered"));
		expect((await (await chat.harness.submission(input.id, context))!.wait(context)).status).toBe("done");
		const submissionId = outcome.status === "completed" ? outcome.result.submissionId! : undefined;
		expect((await (await chat.harness.submission(submissionId!, context))!.wait(context)).status).toBe("done");
		await chat.harness.close(context);
	});
});

describe("compaction and the inbox", () => {
	async function queuedSummary(chat: Chat, content = "SUMMARY") {
		chat.faux.summaries.push(summary(content));
		const outcome = await result(chat, await chat.root.compact(undefined, context));
		return (await chat.harness.submission(
			(outcome.status === "completed" ? outcome.result.submissionId : undefined)!,
			context,
		))!;
	}

	async function busy(chat: Chat, reply = answer("done")) {
		const gate = deferred();
		const reached = deferred();
		chat.faux.agent.push(gated(gate, reply, reached));
		const input = await chat.root.submit({ type: "input", content: "busy" }, context);
		await reached.promise;
		return { input, release: () => gate.resolve() };
	}

	it("places a reset queued after the summary last, and makes a summary queued after a reset stale", async () => {
		for (const order of ["summary first", "reset first"] as const) {
			const chat = await open();
			await history(chat);
			const run = await busy(chat);
			let submission: Awaited<ReturnType<typeof queuedSummary>>;
			if (order === "summary first") {
				submission = await queuedSummary(chat);
				await chat.root.reset(undefined, context);
			} else {
				await chat.root.reset(undefined, context);
				submission = await queuedSummary(chat);
			}
			run.release();
			await run.input.wait(context);
			const settled = await submission.wait(context);
			expect(settled.status).toBe(order === "summary first" ? "done" : "unanswered");
			expect((await kinds(chat.root)).at(-1)).toBe("pi.reset");
			expect((await chat.root.context(context)).head?.kind).toBe("pi.reset");
			await chat.harness.close(context);
		}
	});

	it("places a summary left queued by a failed run at the next submission, before its input", async () => {
		const chat = await open();
		await history(chat);
		const run = await busy(chat, failure("bad request"));
		const submission = await queuedSummary(chat);
		run.release();
		expect((await run.input.wait(context)).status).toBe("unanswered");
		expect((await submission.status(context)).status).toBe("queued");
		await turn(chat, "again", "ok");
		expect((await submission.status(context)).status).toBe("done");
		const request = chat.faux.agentRequests.at(-1)!.messages;
		expect(userText(request[0])).toContain("SUMMARY");
		expect(request.map(userText)).toContain("again");
		await chat.harness.close(context);
	});

	it("keeps the full retry budget after an overflow compaction", async () => {
		const chat = await open();
		await history(chat);
		await chat.root.setCompaction({ ...MANUAL, enabled: true }, context);
		chat.faux.summaries.push(summary());
		chat.faux.agent.push(
			failure("prompt is too long"),
			failure("overloaded"),
			failure("overloaded"),
			answer("finally"),
		);
		const input = await chat.root.submit({ type: "input", content: text("u4", 100) }, context);
		expect((await input.wait(context)).status).toBe("done");
		await chat.harness.close(context);
	});

	it("loses an application edit placed while a compaction summarizes (spec §12)", async () => {
		const chat = await open();
		await history(chat);
		const [u1] = await allEntries(chat.root);
		const gate = deferred();
		const reached = deferred();
		chat.faux.summaries.push(gated(gate, summary(), reached));
		const id = await chat.root.compact(undefined, context);
		await reached.promise;
		const edit = { target: u1!.id, action: "replace", messages: [user("REDACTED")] } as const;
		await chat.root.submit({ type: "write", entry: { kind: "app.redact", edits: [edit] } }, context);
		gate.resolve();
		await result(chat, id);
		// The summary was made from the unredacted entry, and the edit's target left the range.
		expect(userText(chat.faux.summaryRequests[0]!.messages[1])).toContain("[User]: u1 ");
		expect((await chat.root.context(context)).messages.map(userText)).not.toContain("REDACTED");
		await chat.harness.close(context);
	});

	it("keeps the kept entries mounted in the conversation view", async () => {
		const chat = await open();
		await history(chat);
		const state = await chat.root.viewState(context);
		chat.faux.summaries.push(summary());
		await result(chat, await chat.root.compact(undefined, context));
		await waitFor(() => state.value.entries[0]?.kind === "pi.compaction");
		expect(state.value.entries).toEqual((await chat.root.context(context)).entries);
		state.dispose();
		await chat.harness.close(context);
	});
});

describe("compaction edge cases", () => {
	it("keeps the one-compaction limit through a retry backoff", async () => {
		const chat = await open({ contextWindow: 1000 });
		await history(chat);
		await chat.root.setCompaction(BLOCKING, context);
		let asked = 0;
		chat.setup.registry.hooks.add(CompactionTask, {
			beforeCompact: () => {
				asked++;
				return { decline: true };
			},
		});
		chat.faux.agent.push(failure("overloaded"));
		await turn(chat, text("u4", 200), "a4");
		// One blocking compaction, declined; the retried preparation, still above the threshold, started no other.
		expect(asked).toBe(1);
		expect(chat.faux.agentRequests).toHaveLength(5);
		await chat.harness.close(context);
	});

	it("does not start a background compaction when a manual one was admitted during preparation", async () => {
		const chat = await open({ contextWindow: 2000 });
		await history(chat);
		await chat.root.setCompaction(BACKGROUND, context);
		const rendering = deferred();
		const release = deferred();
		let hold = true;
		chat.setup.registry.systemPrompt.section("slow", async () => {
			if (hold) {
				hold = false;
				rendering.resolve();
				await release.promise;
			}
			return "slow";
		});
		const reached = deferred();
		chat.faux.summaries.push(gated(deferred(), summary(), reached));
		chat.faux.agent.push(answer("a4"));
		const input = await chat.root.submit({ type: "input", content: text("u4", 100) }, context);
		await rendering.promise;
		const manual = await chat.root.compact(undefined, context);
		await reached.promise;
		release.resolve();
		expect((await input.wait(context)).status).toBe("done");
		expect((await compactionTasks(chat)).map((task) => task.id)).toEqual([manual]);
		// A background compaction would have sent its own summarization request.
		expect(chat.faux.summaryRequests).toHaveLength(1);
		await chat.harness.abortTask(manual, context);
		await chat.harness.close(context);
	});

	it("starts no background compaction after a blocking one in the same generation", async () => {
		const chat = await open({ contextWindow: 2000 });
		await history(chat);
		// Blocking at 1500, background at 200: the kept part stays above the background threshold.
		await chat.root.setCompaction({ ...BACKGROUND, backgroundTokens: 1300, keepRecentTokens: 400 }, context);
		chat.faux.summaries.push(summary());
		await turn(chat, text("u4", 1000), "a4");
		expect(chat.faux.summaryRequests).toHaveLength(1);
		expect(await compactionTasks(chat)).toEqual([]);
		await chat.harness.close(context);
	});

	it("sends the request anyway when its blocking compaction faults", async () => {
		const chat = await open({ contextWindow: 1000 });
		await history(chat);
		await chat.root.setCompaction(BLOCKING, context);
		const completeSimple = chat.setup.models.completeSimple.bind(chat.setup.models);
		chat.setup.models.completeSimple = () => {
			throw new Error("no credentials");
		};
		await turn(chat, text("u4", 200), "a4");
		chat.setup.models.completeSimple = completeSimple;
		expect((await kinds(chat.root)).includes("pi.compaction")).toBe(false);
		expect((await live(chat)).compactions).toBeUndefined();
		await chat.harness.close(context);
	});

	it("fails an overflow run with its text when its compaction is aborted directly or itself overflows", async () => {
		for (const how of ["abort", "overflow"] as const) {
			const chat = await open();
			await history(chat);
			await chat.root.setCompaction({ ...MANUAL, enabled: true }, context);
			const reached = deferred();
			if (how === "abort") chat.faux.summaries.push(gated(deferred(), summary(), reached));
			else chat.faux.summaries.push(failure("prompt is too long for the summary"));
			chat.faux.agent.push(failure(OVERFLOW));
			const input = await chat.root.submit({ type: "input", content: text("u4", 100) }, context);
			if (how === "abort") {
				await reached.promise;
				const [child] = await compactionTasks(chat);
				await chat.harness.abortTask(child!.id, context);
			}
			expect(await input.wait(context)).toMatchObject({
				status: "unanswered",
				reason: "model_error",
				detail: OVERFLOW,
			});
			expect((await live(chat)).compactions).toBeUndefined();
			await chat.harness.close(context);
		}
	});

	it("treats a length stop as an ordinary answer, not an overflow", async () => {
		const chat = await open();
		await history(chat);
		await chat.root.setCompaction({ ...MANUAL, enabled: true }, context);
		chat.faux.agent.push(fauxAssistantMessage("cut short", { stopReason: "length", errorMessage: OVERFLOW }));
		const input = await chat.root.submit({ type: "input", content: "go" }, context);
		expect((await input.wait(context)).status).toBe("done");
		expect(chat.faux.summaryRequests).toHaveLength(0);
		await chat.harness.close(context);
	});

	it("orders the events of a summary placed at once", async () => {
		const chat = await open();
		await history(chat);
		const events: AgentEvent[] = [];
		const stream = await watchEvents(chat.harness, chat.root.id, context);
		stream.start(async (batch) => {
			events.push(...batch);
		});
		chat.faux.summaries.push(summary());
		await result(chat, await chat.root.compact(undefined, context));
		await waitFor(() => events.some((event) => event.type === "compaction_end"));
		const end = events.findIndex((event) => event.type === "compaction_end");
		const batch = events.slice(end - 2, end + 3).map((event) => event.type);
		expect(batch).toEqual(["message_start", "message_end", "compaction_end", "submission", "usage_changed"]);
		await stream.stop();
		await chat.harness.close(context);
	});

	it("puts compaction_start last in the batch of the preparation commit", async () => {
		const chat = await open({ contextWindow: 2000 });
		await history(chat);
		await chat.root.setCompaction(BACKGROUND, context);
		const events: AgentEvent[][] = [];
		const stream = await watchEvents(chat.harness, chat.root.id, context);
		stream.start(async (batch) => {
			events.push([...batch]);
		});
		// A new section makes the preparation commit append a system entry next to the compaction's status.
		chat.setup.registry.systemPrompt.section("extra", () => "extra");
		chat.faux.summaries.push(gated(deferred(), summary()));
		await turn(chat, text("u4", 100), "a4");
		await waitFor(() => events.some((batch) => batch.some((event) => event.type === "compaction_start")));
		const batch = events.find((candidate) => candidate.some((event) => event.type === "compaction_start"))!;
		expect(batch.map((event) => event.type)).toEqual(["message_start", "message_end", "compaction_start"]);
		await stream.stop();
		await chat.harness.abortTask((await compactionTasks(chat))[0]!.id, context);
		await chat.harness.close(context);
	});

	it("keeps a background summary queued through a retry backoff while a blocking compaction wins", async () => {
		const chat = await open({ contextWindow: 2000 });
		await history(chat);
		await chat.root.setCompaction(BACKGROUND, context);
		await chat.root.setRetryPolicy({ enabled: true, maxRetries: 2, baseDelayMs: 300 }, context);
		const summaryGate = deferred();
		const summaryReached = deferred();
		chat.faux.summaries.push(gated(summaryGate, summary("BACKGROUND"), summaryReached));
		chat.faux.summaries.push(summary("BLOCKING"));
		const failed = deferred();
		chat.faux.agent.push(async () => {
			failed.resolve();
			return failure("overloaded");
		});
		chat.faux.agent.push(answer("a4"));
		const input = await chat.root.submit({ type: "input", content: text("u4", 100) }, context);
		await Promise.all([failed.promise, summaryReached.promise]);
		// During the backoff: the background summary queues, and the thresholds drop so the retry blocks.
		await waitFor(async () => (await live(chat)).generation?.retry !== undefined);
		const [background] = await compactionTasks(chat);
		summaryGate.resolve();
		const queued = await result(chat, background!.id as TaskId<CompactionResult>);
		const submission = (await chat.harness.submission(
			(queued.status === "completed" ? queued.result.submissionId : undefined)!,
			context,
		))!;
		expect((await submission.status(context)).status).toBe("queued");
		await chat.root.setCompaction({ ...BACKGROUND, reserveTokens: 1500, keepRecentTokens: 50 }, context);
		expect((await input.wait(context)).status).toBe("done");
		expect(userText(chat.faux.agentRequests.at(-1)!.messages[0])).toContain("BLOCKING");
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "stale" });
		await chat.harness.close(context);
	});

	it("summarizes the previous summary in a second compaction", async () => {
		const chat = await open();
		await history(chat);
		chat.faux.summaries.push(summary("FIRST"));
		await result(chat, await chat.root.compact(undefined, context));
		await turn(chat, text("u4", 100), text("a4", 100));
		await turn(chat, text("u5", 100), text("a5", 100));
		chat.faux.summaries.push(summary("SECOND"));
		await result(chat, await chat.root.compact(undefined, context));
		const prompt = userText(chat.faux.summaryRequests[1]!.messages[1]);
		expect(prompt).toMatch(/^<conversation>\n\[User\]: The conversation history before this point was compacted/);
		expect(prompt).toContain("FIRST");
		expect(userText((await chat.root.context(context)).messages[0])).toContain("SECOND");
		await chat.harness.close(context);
	});

	it("leaves no usage, submission, summary, or outcome when the classifying commit is rejected", async () => {
		const storage = new ControlledStorage();
		const chat = await open({ storage });
		await history(chat);
		const usage = async () => (await chat.harness.snapshot(UsageDoc, chat.root.id, context))!.models["faux/faux-1"];
		const before = await usage();
		chat.faux.summaries.push(async () => {
			storage.failNextCommit(new StorageRejected("rejected"));
			return summary();
		});
		const id = await chat.root.compact(undefined, context);
		const outcome = await result(chat, id);
		expect(outcome.status).toBe("faulted");
		expect(await usage()).toEqual(before);
		expect((await kinds(chat.root)).includes("pi.compaction")).toBe(false);
		expect((await chat.harness.inspect(context)).submissions).toEqual([]);
		expect(await storage.submissionByRequest(chat.root.id, `compaction:${id}`, context)).toBeUndefined();
		expect((await live(chat)).compactions).toBeUndefined();
		await chat.harness.close(context);
	});
});

describe("blocking and manual compaction together", () => {
	/** A run whose generation waits on a blocking compaction whose summary is held; returns the input and gate. */
	async function blockingRun(chat: Chat) {
		await history(chat);
		await chat.root.setCompaction(BLOCKING, context);
		const gate = deferred();
		const reached = deferred();
		chat.faux.summaries.push(gated(gate, summary("BLOCKING"), reached));
		const input = await chat.root.submit({ type: "input", content: text("u4", 200) }, context);
		await reached.promise;
		const [blocking] = await compactionTasks(chat);
		return { input, gate, blocking: blocking!.id as TaskId<CompactionResult> };
	}

	it("places a manual summary selected before the blocking one landed; its equal cut replaces it", async () => {
		const chat = await open({ contextWindow: 1000 });
		const run = await blockingRun(chat);
		// Selected from the same context as the blocking compaction, so it cuts at the same entry.
		chat.faux.summaries.push(summary("MANUAL"));
		const manual = await result(chat, await chat.root.compact(undefined, context));
		const submission = (await chat.harness.submission(
			(manual.status === "completed" ? manual.result.submissionId : undefined)!,
			context,
		))!;
		expect((await submission.status(context)).status).toBe("queued");
		chat.faux.agent.push(answer("a4"));
		run.gate.resolve();
		expect((await run.input.wait(context)).status).toBe("done");
		// The request after the blocking compaction used its summary; the manual one landed at the final boundary.
		expect(userText(chat.faux.agentRequests.at(-1)!.messages[0])).toContain("BLOCKING");
		expect((await submission.wait(context)).status).toBe("done");
		const markers = (await allEntries(chat.root)).filter((record) => record.kind === "pi.compaction");
		expect(markers).toHaveLength(2);
		expect(markers[1]!.head).toBe(markers[0]!.head);
		const messages = (await chat.root.context(context)).messages;
		expect(userText(messages[0])).toContain("MANUAL");
		expect(messages.some((message) => userText(message).includes("BLOCKING"))).toBe(false);
		await chat.harness.close(context);
	});

	it("finds nothing to compact for a manual compaction selected after the blocking summary landed", async () => {
		const chat = await open({ contextWindow: 1000 });
		const run = await blockingRun(chat);
		const answerGate = deferred();
		const answerReached = deferred();
		chat.faux.agent.push(gated(answerGate, answer("a4"), answerReached));
		run.gate.resolve();
		await answerReached.promise;
		expect(await result(chat, await chat.root.compact(undefined, context))).toEqual({
			status: "completed",
			result: {},
		});
		expect(chat.faux.summaryRequests).toHaveLength(1);
		answerGate.resolve();
		expect((await run.input.wait(context)).status).toBe("done");
		await chat.harness.close(context);
	});

	it("aborts the run and both compactions on Esc and appends nothing", async () => {
		const chat = await open({ contextWindow: 1000 });
		const run = await blockingRun(chat);
		const manualReached = deferred();
		chat.faux.summaries.push(gated(deferred(), summary("MANUAL"), manualReached));
		const manual = await chat.root.compact(undefined, context);
		await manualReached.promise;
		expect((await live(chat)).compactions?.map((status) => status.blocking)).toEqual([true, false]);
		await chat.root.abort(context);
		expect(await run.input.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect((await result(chat, run.blocking)).status).toBe("aborted");
		expect((await result(chat, manual)).status).toBe("aborted");
		expect((await live(chat)).compactions).toBeUndefined();
		expect((await live(chat)).run).toBeUndefined();
		expect((await kinds(chat.root)).includes("pi.compaction")).toBe(false);
		expect((await chat.harness.inspect(context)).submissions).toEqual([]);
		await chat.harness.close(context);
	});

	it("places a summary that survived Esc at the next submission, before its input", async () => {
		const chat = await open();
		await history(chat);
		const reached = deferred();
		chat.faux.agent.push(gated(deferred(), answer("never"), reached));
		const busy = await chat.root.submit({ type: "input", content: "busy" }, context);
		await reached.promise;
		chat.faux.summaries.push(summary());
		const outcome = await result(chat, await chat.root.compact(undefined, context));
		const submission = (await chat.harness.submission(
			(outcome.status === "completed" ? outcome.result.submissionId : undefined)!,
			context,
		))!;
		await chat.root.abort(context);
		expect(await busy.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect((await submission.status(context)).status).toBe("queued");
		await turn(chat, "u5", "a5");
		expect((await submission.status(context)).status).toBe("done");
		const request = chat.faux.agentRequests.at(-1)!.messages;
		expect(userText(request[0])).toContain("SUMMARY");
		expect(request.map(userText)).toContain("u5");
		const tail = (await allEntries(chat.root)).slice(-4).map((record) => record.kind);
		expect(tail).toEqual(["pi.compaction", "pi.user", "pi.system", "pi.assistant"]);
		await chat.harness.close(context);
	});
});

describe("compaction pinning, silent overflow, and late policy changes", () => {
	it("keeps the pinned model through a retry and advances the live attempt", async () => {
		const setup = chatSetup({
			models: [
				{ id: "faux-1", contextWindow: 100_000, maxTokens: 900 },
				{ id: "faux-2", contextWindow: 100_000, maxTokens: 900 },
			],
		});
		const chat = await open({}, setup);
		await history(chat);
		let attempt: number | undefined;
		chat.faux.summaries.push(async () => {
			// Switched during the attempt: the retry still uses the pinned model.
			await chat.root.setModel({ provider: "faux", modelId: "faux-2" }, context);
			return failure("overloaded");
		});
		chat.faux.summaries.push(async () => {
			attempt = (await live(chat)).compactions?.[0]?.attempt;
			return summary();
		});
		expect((await result(chat, await chat.root.compact(undefined, context))).status).toBe("completed");
		expect(chat.faux.summaryRequests.map((request) => request.model)).toEqual(["faux-1", "faux-1"]);
		expect(attempt).toBe(2);
		const usage = (await chat.harness.snapshot(UsageDoc, chat.root.id, context))!.models;
		expect(Object.keys(usage)).toEqual(["faux/faux-1"]);
		await chat.harness.close(context);
	});

	it("shows a late joiner a compaction that is summarizing", async () => {
		const chat = await open();
		await history(chat);
		const reached = deferred();
		chat.faux.summaries.push(gated(deferred(), summary(), reached));
		const id = await chat.root.compact(undefined, context);
		await reached.promise;
		const stream = await watchEvents(chat.harness, chat.root.id, context);
		expect(stream.snapshot.compactions).toEqual([{ taskId: id, reason: "manual", blocking: false, attempt: 1 }]);
		await stream.stop();
		await chat.harness.abortTask(id, context);
		await chat.harness.close(context);
	});

	for (const [name, response] of [
		["a stop whose input exceeds the window", answer("fine")],
		["a length stop that fills the window without output", fauxAssistantMessage("", { stopReason: "length" })],
	] as const) {
		it(`treats silent overflow as an ordinary answer: ${name}`, async () => {
			const chat = await open({ contextWindow: 300 });
			await history(chat);
			// Thresholds out of reach, so only overflow classification could compact.
			await chat.root.setCompaction(
				{ enabled: true, reserveTokens: -100_000, keepRecentTokens: 150, backgroundTokens: 0 },
				context,
			);
			chat.faux.agent.push(response);
			const input = await chat.root.submit({ type: "input", content: "go" }, context);
			expect((await input.wait(context)).status).toBe("done");
			const [last] = (await allEntries(chat.root)).slice(-1);
			const message = last!.model![0] as AssistantMessage;
			expect(message.usage.input).toBeGreaterThanOrEqual(300);
			expect(chat.faux.summaryRequests).toHaveLength(0);
			await chat.harness.close(context);
		});
	}

	it("sends the request when a blocking compaction finds nothing under a policy changed after preparation", async () => {
		const chat = await open({ contextWindow: 1000 });
		await history(chat);
		await chat.root.setCompaction(BLOCKING, context);
		let changed = false;
		chat.setup.registry.systemPrompt.section("policy", async () => {
			// Rendering runs after preparation read the policy; the compaction reads this one.
			if (!changed) {
				changed = true;
				await chat.root.setCompaction({ ...BLOCKING, keepRecentTokens: 100_000 }, context);
			}
			return "p";
		});
		await turn(chat, text("u4", 200), "a4");
		const compactions = (await chat.harness.inspect(context)).tasks.filter(
			(task) => task.record.kind === "pi.compaction",
		);
		expect(compactions).toEqual([]);
		expect(chat.faux.summaryRequests).toHaveLength(0);
		expect((await kinds(chat.root)).includes("pi.compaction")).toBe(false);
		await chat.harness.close(context);
	});
});

describe("blocked compaction", () => {
	it("survives reopen blocked and is orphaned on abort with its status removed", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		let { harness, root } = await openChat(await openNodeSqliteStorage(path), setup);
		// A compaction stored by a newer version than this process registers, for example after a downgrade.
		const newer = { definition: { ...CompactionTask.definition, version: 2 } } as typeof CompactionTask;
		const id = await root.commit(async (tx) => {
			const taskId = await tx.createTask(newer, { reason: "manual" }, { ownership: { kind: "conversation" } });
			const live = await tx.doc(LiveDoc, root.id);
			live.compactions = [{ taskId, reason: "manual", blocking: false, attempt: 1 }];
			return taskId;
		}, context);
		await harness.close(context);
		({ harness, root } = await openChat(await openNodeSqliteStorage(path), setup));
		harness.resume();
		const chat = { harness, root, setup, faux: script(setup) };
		const events: AgentEvent[] = [];
		const stream = await watchEvents(chat.harness, chat.root.id, context);
		stream.start(async (batch) => {
			events.push(...batch);
		});
		const inspection = await chat.harness.inspect(context);
		expect(inspection.tasks.find((task) => task.record.id === id)?.state).toEqual({
			kind: "blocked",
			reason: "task_too_old",
		});
		await chat.harness.abortTask(id, context);
		expect((await chat.harness.waitForTask(id, context)).state.outcome).toEqual({
			status: "orphaned",
			reason: "task_too_old",
		});
		expect((await live(chat)).compactions).toBeUndefined();
		await waitFor(() => events.some((event) => event.type === "compaction_end"));
		await stream.stop();
		await chat.harness.close(context);
	});
});

describe("context contributions", () => {
	it("apply edits carried by an older head marker in the range", async () => {
		const chat = await open();
		const ids = await chat.root.commit(async (tx) => {
			const a = await tx.appendEntry(chat.root.id, { kind: "app.note", model: [user("a")] });
			const b = await tx.appendEntry(chat.root.id, { kind: "app.note", model: [user("b")] });
			// An older marker that omits b, then a newer one whose range still contains the older marker.
			await tx.appendEntry(chat.root.id, {
				kind: "app.head",
				head: a.id,
				edits: [{ target: b.id, action: "omit" }],
			});
			const c = await tx.appendEntry(chat.root.id, { kind: "app.note", model: [user("c")] });
			await tx.appendEntry(chat.root.id, { kind: "app.head", head: a.id, model: [user("H")] });
			return { a: a.id, b: b.id, c: c.id };
		}, context);
		const view = await chat.root.context(context);
		expect(view.entries.map((record) => record.id).slice(1)).toEqual([ids.a, ids.b, ids.c]);
		expect(view.contributions.map((messages) => messages.map(userText))).toEqual([["H"], ["a"], [], ["c"]]);
		expect(view.messages.map(userText)).toEqual(["H", "a", "c"]);
		// The summarizer sees the same contributions: the omitted entry stays out.
		await chat.root.setCompaction({ ...MANUAL, keepRecentTokens: 1 }, context);
		chat.faux.summaries.push(summary());
		await result(chat, await chat.root.compact(undefined, context));
		const prompt = userText(chat.faux.summaryRequests[0]!.messages[1]);
		expect(prompt).toContain("<conversation>\n[User]: H\n\n[User]: a\n</conversation>");
		await chat.harness.close(context);
	});
});
