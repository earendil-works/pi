import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createModels, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { AssistantEntry, type Harness, LiveDoc, type TaskId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf, unanswered, waitFor } from "./chat-support.ts";
import { context } from "./session-support.ts";
import { aborted, deferred } from "./task-support.ts";

const directories = new Set<string>();

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-generation-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

async function open(path: string, setup: ChatSetup) {
	return openChat(await openNodeSqliteStorage(path), setup);
}

async function runTaskId(harness: Harness): Promise<TaskId> {
	const live = await harness.snapshot(LiveDoc, 1 as never, context);
	return live!.run!.taskId;
}

async function checkpoint(harness: Harness, id: TaskId) {
	const record = await harness.getTask(id, context);
	return record?.state.status === "terminal" ? undefined : record?.state.checkpoint;
}

describe("generation recovery", () => {
	it("reruns preparation interrupted before its commit", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		const reached = deferred();
		let block = true;
		setup.registry.systemPrompt.section("preamble", async (_input, ctx) => {
			if (block) {
				block = false;
				reached.resolve();
				await aborted(ctx.abortSignal!);
			}
			return "p";
		});
		setup.faux.setResponses([fauxAssistantMessage("answer")]);
		let opened = await open(path, setup);
		opened.harness.resume();
		const id = (await opened.root.submit({ type: "input", content: "hi" }, context)).id;
		await reached.promise;
		const taskId = await runTaskId(opened.harness);
		await opened.harness.close(context);

		opened = await open(path, setup);
		expect(await checkpoint(opened.harness, taskId)).toEqual({ phase: "prepare", attempt: 1 });
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect((await allEntries(opened.root)).map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.system",
			"pi.assistant",
		]);
		await opened.harness.close(context);
	});

	it("resends a request interrupted before any partial without repeating preparation", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		setup.registry.systemPrompt.section("preamble", () => "p", { tag: false });
		const reached = deferred();
		const sent: string[][] = [];
		const timeouts: (number | undefined)[] = [];
		setup.faux.setResponses([
			async (_context, options) => {
				reached.resolve();
				return aborted(options!.signal!);
			},
			(request, options) => {
				sent.push(request.messages.map((message) => message.role));
				timeouts.push(options?.timeoutMs);
				return fauxAssistantMessage("answer");
			},
		]);
		let opened = await open(path, setup);
		await opened.root.setStreamOptions({ timeoutMs: 1234 }, context);
		opened.harness.resume();
		const id = (await opened.root.submit({ type: "input", content: "hi" }, context)).id;
		await reached.promise;
		const taskId = await runTaskId(opened.harness);
		await opened.harness.close(context);

		opened = await open(path, setup);
		expect(await checkpoint(opened.harness, taskId)).toMatchObject({
			phase: "request",
			attempt: 1,
			thinkingLevel: "off",
			streamOptions: { timeoutMs: 1234 },
		});
		// The resend uses the pinned request, not options changed after preparation.
		await opened.root.setStreamOptions({ timeoutMs: 999 }, context);
		expect(await opened.harness.snapshot(LiveDoc, opened.root.id, context)).toMatchObject({
			generation: { attempt: 1 },
		});
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect(sent).toEqual([["user", "system"]]);
		expect(timeouts).toEqual([1234]);
		expect((await allEntries(opened.root)).map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.system",
			"pi.assistant",
		]);
		await opened.harness.close(context);
	});

	it("converts a committed partial into an aborted entry and resends the same messages", async () => {
		const path = await sqlitePath();
		const slow = chatSetup({ tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
		slow.faux.setResponses([fauxAssistantMessage("z".repeat(400))]);
		let opened = await open(path, slow);
		opened.harness.resume();
		const watch = (await opened.harness.watchDoc(LiveDoc, opened.root.id, context))!;
		let watched: string | undefined;
		watch.start(async (value) => {
			watched = textOf(value?.generation?.message as Message) ?? watched;
		});
		const id = (await opened.root.submit({ type: "input", content: "hi" }, context)).id;
		await waitFor(() => watched !== undefined);
		await opened.harness.close(context);

		const setup = chatSetup();
		const sent: string[][] = [];
		setup.faux.setResponses([
			(request) => {
				sent.push(request.messages.map((message) => message.role));
				return fauxAssistantMessage("answer");
			},
		]);
		opened = await open(path, setup);
		const stored = await opened.harness.snapshot(LiveDoc, opened.root.id, context);
		const partial = textOf(stored?.generation?.message as Message)!;
		// Everything observers saw before the crash is durable.
		expect(partial.startsWith(watched!)).toBe(true);
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect(sent).toEqual([["user"]]);
		const entries = await allEntries(opened.root);
		expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant", "pi.assistant"]);
		const converted = entries[1]!.model![0] as AssistantMessage;
		expect(converted.stopReason).toBe("aborted");
		expect(textOf(converted)).toBe(partial);
		expect(await opened.harness.snapshot(LiveDoc, opened.root.id, context)).toEqual({});
		await opened.harness.close(context);
	});

	it("resumes a retry backoff after reopen", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		let now = 1_000;
		setup.now = () => now;
		setup.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" }),
			fauxAssistantMessage("recovered"),
		]);
		let opened = await open(path, setup);
		opened.harness.resume();
		await opened.root.setRetryPolicy({ enabled: true, maxRetries: 2, baseDelayMs: 60_000 }, context);
		const id = (await opened.root.submit({ type: "input", content: "hi" }, context)).id;
		await waitFor(async () => {
			const live = await opened.harness.snapshot(LiveDoc, opened.root.id, context);
			return live?.generation?.retry !== undefined;
		});
		const taskId = await runTaskId(opened.harness);
		await opened.harness.close(context);

		opened = await open(path, setup);
		expect(await checkpoint(opened.harness, taskId)).toEqual({ phase: "retry", attempt: 1, until: 61_000 });
		expect(await opened.harness.snapshot(LiveDoc, opened.root.id, context)).toEqual({
			run: { taskId, inputs: [id] },
			generation: { attempt: 1, retry: { at: 61_000, error: "503 Service Unavailable" } },
		});
		now = 61_000;
		opened.harness.resume();
		expect((await (await opened.harness.submission(id, context))!.wait(context)).status).toBe("done");
		expect((await allEntries(opened.root)).map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.assistant",
			"pi.assistant",
		]);
		await opened.harness.close(context);
	});

	it("resumes polling a deferred response after reopen", async () => {
		const path = await sqlitePath();
		const setup = chatSetup({ deferred: { pollAfterMs: 60_000 } });
		let now = 1_000;
		setup.now = () => now;
		setup.faux.setResponses([fauxAssistantMessage("deferred answer")]);
		let opened = await open(path, setup);
		opened.harness.resume();
		await opened.root.setStreamOptions({ deferred: true }, context);
		const id = (await opened.root.submit({ type: "input", content: "hi" }, context)).id;
		await waitFor(async () => {
			const live = await opened.harness.snapshot(LiveDoc, opened.root.id, context);
			return live?.generation?.deferred !== undefined;
		});
		const taskId = await runTaskId(opened.harness);
		await opened.harness.close(context);

		opened = await open(path, setup);
		expect(await checkpoint(opened.harness, taskId)).toMatchObject({ phase: "poll", attempt: 1, pollAt: 61_000 });
		now = 61_000;
		opened.harness.resume();
		const settled = await (await opened.harness.submission(id, context))!.wait(context);
		if (settled.status !== "done" || settled.type !== "input") throw new Error(`Unexpected ${settled.status}`);
		const answer = await opened.root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		expect(textOf(answer?.model?.[0])).toBe("deferred answer");
		expect(setup.faux.state.deferredFetchCount).toBe(1);
		await opened.harness.close(context);
	});

	it("fails no_model when the pinned model is gone after reopen, in request and in poll", async () => {
		const path = await sqlitePath();
		const setup = chatSetup({ deferred: { pollAfterMs: 60_000 } });
		const busy = unanswered();
		setup.faux.setResponses([busy.step, fauxAssistantMessage("deferred")]);
		let opened = await open(path, setup);
		opened.harness.resume();
		const requesting = (await opened.root.submit({ type: "input", content: "one" }, context)).id;
		await busy.reached;
		await opened.harness.close(context);

		// Reopened without the faux provider: the request's pinned model is unknown.
		const empty: ChatSetup = { ...setup, models: createModels() };
		opened = await open(path, empty);
		opened.harness.resume();
		expect(await (await opened.harness.submission(requesting, context))!.wait(context)).toMatchObject({
			status: "unanswered",
			reason: "no_model",
		});
		await opened.harness.close(context);

		opened = await open(path, setup);
		await opened.root.setStreamOptions({ deferred: true }, context);
		opened.harness.resume();
		const polling = (await opened.root.submit({ type: "input", content: "two" }, context)).id;
		await waitFor(async () => {
			const live = await opened.harness.snapshot(LiveDoc, opened.root.id, context);
			return live?.generation?.deferred !== undefined;
		});
		await opened.harness.close(context);

		opened = await open(path, empty);
		opened.harness.resume();
		expect(await (await opened.harness.submission(polling, context))!.wait(context)).toMatchObject({
			status: "unanswered",
			reason: "no_model",
		});
		await opened.harness.close(context);
	});

	it("runs a print-style turn and reads the durable answer after reopen", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		setup.registry.systemPrompt.section("preamble", () => "You are terse.", { tag: false });
		setup.faux.setResponses([fauxAssistantMessage("42")]);
		let opened = await open(path, setup);
		opened.harness.resume();
		const submission = await opened.root.submit({ type: "input", content: "answer?" }, context);
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") throw new Error(`Unexpected ${settled.status}`);
		const answer = await opened.root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		expect(textOf(answer?.model?.[0])).toBe("42");
		await opened.harness.close(context);

		opened = await open(path, setup);
		expect(await (await opened.harness.submission(submission.id, context))!.status(context)).toEqual(settled);
		expect(await opened.root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)).toEqual(answer);
		await opened.harness.close(context);
	});
});
