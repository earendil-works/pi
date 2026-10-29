// What a crash (a host that dies, is evicted, or is reset) does to work that was running: a generation's interrupted
// request is a failed attempt under the retry policy, and every other task ends visibly once it was cut off
// `settings.restartLimit` times in a row (#11139).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Message,
	type Models,
	type ToolResultMessage,
	Type,
} from "@earendil-works/pi-ai";
import {
	defineTool,
	type GenerationCheckpoint,
	type Harness,
	LiveDoc,
	type LiveState,
	MemoryStorage,
	ROOT_CONVERSATION_ID,
	type Storage,
	type SubmissionId,
	type TaskId,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf, unanswered, waitFor } from "./chat-support.ts";
import { addSection, addTool } from "./harness-support.ts";
import { context, followCommits } from "./session-support.ts";
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
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-restart-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

/**
 * Open a chat over the SQLite file at `path`. `kill()` simulates a crash: every later storage call hangs, so the Harness
 * writes nothing more, not even the `pending` records a close writes for the tasks it stops.
 */
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
	const kill = (): void => {
		dead = true;
		killed.add(inner);
	};
	return { ...opened, kill };
}

async function live(harness: Harness): Promise<Readonly<LiveState>> {
	return (await harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context)) ?? {};
}

/** Every `pi.live` value from now on, as memory adopts it. */
function liveValues(harness: Harness): LiveState[] {
	const values: LiveState[] = [];
	followCommits(harness, (publication) => {
		for (const change of publication.changes) {
			if (change.type === "document" && change.record.kind === "pi.live" && change.kind === "change") {
				values.push(change.value as LiveState);
			}
		}
	});
	return values;
}

/** Let deferred progress commits (`persistWithinMs: 0`) reach Storage before a crash. */
function stored(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 50));
}

/** A setup whose model streams a long answer slowly; partials are stored as soon as they are committed. */
function streaming(): ChatSetup {
	const setup = chatSetup({ tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
	setup.faux.setResponses([fauxAssistantMessage("z".repeat(400))]);
	setup.settings.progress = { persistWithinMs: 0 };
	return setup;
}

/** Submit an input to a fresh chat at `path` and crash once its streamed partial is stored. */
async function crashWhileStreaming(path: string, setup: ChatSetup) {
	const opened = await open(path, setup);
	opened.harness.resume();
	const id = (await opened.root.submit({ type: "input", content: "hi" }, context)).id;
	await waitFor(async () => (await live(opened.harness)).generation?.message !== undefined);
	const taskId = (await live(opened.harness)).run!.taskId;
	await stored();
	opened.kill();
	return { id, taskId };
}

/** Reopen after a crash in the middle of a request, with another streaming answer, and crash again. */
async function crashAgain(path: string, setup: ChatSetup, taskId: TaskId) {
	const opened = await open(path, setup);
	opened.harness.resume();
	// The first attempt was charged; the second one streams.
	await waitFor(async () => {
		const state = (await opened.harness.getTask(taskId, context))?.state;
		if (state?.status !== "running") return false;
		const checkpoint = state.checkpoint as GenerationCheckpoint;
		return checkpoint.phase === "request" && checkpoint.attempt === 2;
	});
	await waitFor(async () => (await live(opened.harness)).generation?.message !== undefined);
	await stored();
	opened.kill();
}

async function settled(harness: Harness, id: SubmissionId) {
	return (await harness.submission(id, context))!.wait(context);
}

describe("a generation interrupted while the model answers (#11139)", () => {
	it("charges the attempt: keeps the partial, waits for the retry backoff, and answers on the next attempt", async () => {
		const path = await sqlitePath();
		const first = streaming();
		first.settings.retry = { enabled: true, maxRetries: 2, baseDelayMs: 1 };
		const { id, taskId } = await crashWhileStreaming(path, first);

		const setup = chatSetup();
		setup.settings.retry = { enabled: true, maxRetries: 2, baseDelayMs: 1 };
		const sent: string[][] = [];
		setup.faux.setResponses([
			(request) => {
				sent.push(request.messages.map((message) => message.role));
				return fauxAssistantMessage("answer");
			},
		]);
		const opened = await open(path, setup);
		const values = liveValues(opened.harness);
		const partial = textOf((await live(opened.harness)).generation?.message as Message)!;
		expect((await opened.harness.getTask(taskId, context))?.restarts).toBe(1);
		opened.harness.resume();
		expect((await settled(opened.harness, id)).status).toBe("done");
		// The backoff showed in `pi.live` with why.
		const retry = values.find((value) => value.generation?.retry !== undefined)?.generation;
		expect(retry).toEqual({
			attempt: 1,
			retry: { at: expect.any(Number), error: "The host stopped while the model was answering, on attempt 1" },
		});
		expect(values.some((value) => value.generation?.attempt === 2)).toBe(true);
		const entries = await allEntries(opened.root);
		expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant", "pi.assistant"]);
		const converted = entries[1]!.model![0] as AssistantMessage;
		expect(converted.stopReason).toBe("aborted");
		expect(textOf(converted)).toBe(partial);
		// The aborted partial is excluded from the next request.
		expect(sent).toEqual([["user"]]);
		expect(await live(opened.harness)).toEqual({});
		await opened.harness.close(context);
	});

	it("sleeps the backoff of `settings.retry` before the next attempt", async () => {
		const path = await sqlitePath();
		const first = streaming();
		first.settings.retry = { enabled: true, maxRetries: 2, baseDelayMs: 60_000 };
		const { taskId } = await crashWhileStreaming(path, first);

		const setup = chatSetup();
		setup.settings.retry = { enabled: true, maxRetries: 2, baseDelayMs: 60_000 };
		const now = 1_000_000;
		setup.now = () => now;
		const opened = await open(path, setup);
		opened.harness.resume();
		await waitFor(async () => (await opened.harness.getTask(taskId, context))?.state.status === "sleeping");
		const record = await opened.harness.getTask(taskId, context);
		expect(record?.state).toMatchObject({ status: "sleeping", until: now + 60_000, checkpoint: { phase: "retry" } });
		expect(record?.restarts).toBeUndefined();
		expect((await live(opened.harness)).generation).toEqual({
			attempt: 1,
			retry: { at: now + 60_000, error: "The host stopped while the model was answering, on attempt 1" },
		});
		expect(opened.harness.wake()).toEqual({ active: false, at: now + 60_000 });
		await opened.harness.close(context);
	});

	it("ends the run interrupted once no retry is left, keeping every partial", async () => {
		const path = await sqlitePath();
		const first = streaming();
		first.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
		const { id, taskId } = await crashWhileStreaming(path, first);
		// Attempt 2 is interrupted too.
		const second = streaming();
		second.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
		await crashAgain(path, second, taskId);

		const setup = chatSetup();
		setup.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
		const opened = await open(path, setup);
		opened.harness.resume();
		const text = "The host stopped while the model was answering, on attempt 2";
		expect(await settled(opened.harness, id)).toMatchObject({
			status: "unanswered",
			reason: "interrupted",
			detail: text,
		});
		expect(await live(opened.harness)).toEqual({
			runFailure: { taskId, inputs: [id], reason: "interrupted", detail: text, first: expect.any(Number) },
		});
		expect((await opened.harness.waitForTask(taskId, context)).state.outcome).toEqual({
			status: "failed",
			error: { message: text, detail: { reason: "interrupted" } },
		});
		const entries = await allEntries(opened.root);
		expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant", "pi.assistant"]);
		expect(entries.slice(1).map((entry) => (entry.model![0] as AssistantMessage).stopReason)).toEqual([
			"aborted",
			"aborted",
		]);
		// No request was sent after the second crash.
		expect(setup.faux.state.callCount).toBe(0);
		await opened.harness.close(context);
	});

	it("ends the run at once when retries are disabled", async () => {
		const path = await sqlitePath();
		const first = streaming();
		const { id } = await crashWhileStreaming(path, first);
		const setup = chatSetup();
		setup.settings.retry = { enabled: false };
		const opened = await open(path, setup);
		opened.harness.resume();
		expect(await settled(opened.harness, id)).toMatchObject({ status: "unanswered", reason: "interrupted" });
		await opened.harness.close(context);
	});

	it("resends after a clean close: a close is not a crash", async () => {
		const path = await sqlitePath();
		const first = streaming();
		first.settings.retry = { enabled: false };
		const opened = await open(path, first);
		opened.harness.resume();
		const id = (await opened.root.submit({ type: "input", content: "hi" }, context)).id;
		await waitFor(async () => (await live(opened.harness)).generation?.message !== undefined);
		const taskId = (await live(opened.harness)).run!.taskId;
		await opened.harness.close(context);

		const setup = chatSetup();
		setup.settings.retry = { enabled: false };
		setup.faux.setResponses([fauxAssistantMessage("answer")]);
		const reopened = await open(path, setup);
		expect((await reopened.harness.getTask(taskId, context))?.restarts).toBeUndefined();
		reopened.harness.resume();
		expect((await settled(reopened.harness, id)).status).toBe("done");
		await reopened.harness.close(context);
	});

	it("does not charge a generation that sleeps in a retry or waits for its tools", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		setup.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 60_000 };
		const gate = deferred();
		const started = deferred();
		addTool(
			setup.registry,
			defineTool({
				name: "hold",
				description: "Waits",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async () => {
					started.resolve();
					await gate.promise;
					return {};
				},
			}),
		);
		const error = fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" });
		setup.faux.setResponses([error]);
		let opened = await open(path, setup);
		opened.harness.resume();
		const id = (await opened.root.submit({ type: "input", content: "hi" }, context)).id;
		const taskId = (await live(opened.harness)).run!.taskId;
		await waitFor(async () => (await opened.harness.getTask(taskId, context))?.state.status === "sleeping");
		opened.kill();

		// Asleep in its retry: not running, so not cut off.
		const later = chatSetup();
		later.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 60_000 };
		later.now = () => Date.now() + 120_000;
		addTool(later.registry, setup.registry.snapshot().tools()[0]!.tool);
		later.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {}, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		opened = await open(path, later);
		expect((await opened.harness.getTask(taskId, context))?.restarts).toBeUndefined();
		opened.harness.resume();
		// Waiting for its tool round: not running either.
		await started.promise;
		const waiting = await opened.harness.getTask(taskId, context);
		expect(waiting?.state).toMatchObject({ status: "waiting", checkpoint: { phase: "tools" } });
		opened.kill();

		opened = await open(path, later);
		expect((await opened.harness.getTask(taskId, context))?.restarts).toBeUndefined();
		gate.resolve();
		opened.harness.resume();
		expect((await settled(opened.harness, id)).status).toBe("done");
		await opened.harness.close(context);
	});

	it("ends a run whose generation is cut off restartLimit times outside a request", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		setup.settings.restartLimit = 1;
		const reached = deferred();
		// Preparation never finishes, as one that exhausts the host's memory would not.
		addSection(setup.registry, "preamble", async (_input, ctx) => {
			reached.resolve();
			return aborted(ctx.abortSignal!);
		});
		let opened = await open(path, setup);
		opened.harness.resume();
		const id = (await opened.root.submit({ type: "input", content: "hi" }, context)).id;
		await reached.promise;
		const taskId = (await live(opened.harness)).run!.taskId;
		opened.kill();

		opened = await open(path, setup);
		opened.harness.resume();
		const text = "The generation was interrupted once in its prepare phase";
		expect(await settled(opened.harness, id)).toMatchObject({
			status: "unanswered",
			reason: "restart_limit",
			detail: text,
		});
		expect(await live(opened.harness)).toEqual({
			runFailure: { taskId, inputs: [id], reason: "restart_limit", detail: text, first: expect.any(Number) },
		});
		await waitFor(() => setup.infos.length > 0);
		expect(setup.infos).toContainEqual(
			expect.objectContaining({ kind: "task_interrupted", reason: "restart_limit", restarts: 1 }),
		);
		await opened.harness.close(context);
	});
});

describe("other tasks cut off restartLimit times in a row (#11139)", () => {
	it("ends a tool call with an error result instead of running it again", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		setup.settings.restartLimit = 2;
		setup.settings.progress = { outputIntervalMs: 0, persistWithinMs: 0 };
		let runs = 0;
		const running = { current: deferred() };
		addTool(
			setup.registry,
			defineTool({
				name: "heavy",
				description: "Never finishes",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async (_args, api, ctx) => {
					runs++;
					api.output("partial\n");
					running.current.resolve();
					return aborted(ctx.abortSignal!);
				},
			}),
		);
		const answers: FauxResponseStep[] = [
			() => fauxAssistantMessage([fauxToolCall("heavy", {}, { id: "c1" })], { stopReason: "toolUse" }),
			(request) => {
				const result = request.messages.at(-1) as ToolResultMessage;
				return fauxAssistantMessage(`saw: ${textOf(result)}`);
			},
		];
		setup.faux.setResponses(answers);
		let opened = await open(path, setup);
		opened.harness.resume();
		const id = (await opened.root.submit({ type: "input", content: "go" }, context)).id;
		for (let crash = 1; crash <= 2; crash++) {
			await running.current.promise;
			running.current = deferred();
			await stored();
			opened.kill();
			opened = await open(path, setup);
			opened.harness.resume();
		}
		expect((await settled(opened.harness, id)).status).toBe("done");
		expect(runs).toBe(2);
		const result = (await allEntries(opened.root)).find((entry) => entry.kind === "pi.tool-result")!;
		const message = result.model![0] as ToolResultMessage;
		expect(message.isError).toBe(true);
		expect(result.data).toMatchObject({
			diagnostics: [
				{
					severity: "error",
					code: "restart_limit",
					message: "Tool heavy was interrupted 2 times in a row; it is not run again",
				},
			],
		});
		// The slot's partial output is kept, as for an interrupted call.
		expect(textOf(message)).toContain("partial");
		const toolTask = (await opened.harness.commit((tx) => tx.scanTasks({ kind: "pi.tool" }, 10), context)).items[0]!;
		expect(toolTask.state).toMatchObject({
			status: "terminal",
			outcome: { status: "failed", error: { detail: { reason: "restart_limit" } } },
		});
		expect(setup.infos).toContainEqual({
			kind: "task_interrupted",
			task: { id: toolTask.id, kind: "pi.tool", conversationId: ROOT_CONVERSATION_ID },
			reason: "restart_limit",
			restarts: 2,
		});
		await opened.harness.close(context);
	});

	it("fails a compaction into compactionFailure", async () => {
		const path = await sqlitePath();
		const setup = chatSetup();
		setup.settings.restartLimit = 1;
		// Little recent context is kept, so the first turn is summarized.
		setup.settings.compaction = { enabled: false, keepRecentTokens: 10 };
		setup.faux.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2")]);
		let opened = await open(path, setup);
		opened.harness.resume();
		await (await opened.root.submit({ type: "input", content: "u1 ".repeat(200) }, context)).wait(context);
		await (await opened.root.submit({ type: "input", content: "u2 ".repeat(200) }, context)).wait(context);
		// The summary request never returns.
		const hanging = unanswered();
		setup.faux.setResponses([hanging.step]);
		const compaction = await opened.root.compact(undefined, context);
		await hanging.reached;
		opened.kill();

		opened = await open(path, setup);
		opened.harness.resume();
		const error = "Compaction was interrupted once";
		expect((await opened.harness.waitForTask(compaction, context)).state.outcome).toEqual({
			status: "failed",
			error: { message: error, detail: { reason: "restart_limit" } },
		});
		expect((await live(opened.harness)).compactionFailure).toEqual({
			taskId: compaction,
			trigger: "manual",
			error,
		});
		expect((await live(opened.harness)).compactions).toBeUndefined();
		await waitFor(() => setup.infos.length > 0);
		expect(setup.infos).toContainEqual({
			kind: "task_interrupted",
			task: { id: compaction, kind: "pi.compaction", conversationId: ROOT_CONVERSATION_ID },
			reason: "restart_limit",
			restarts: 1,
		});
		await opened.harness.close(context);
	});
});

/**
 * A setup whose model answers deferred, and whose first fetch of each deferred response is in flight until the Harness
 * stops; later fetches answer. `fetching` resolves when the first fetch began.
 */
function deferredSetup(pollAfterMs = 10) {
	const base = chatSetup({ deferred: { pollAfterMs } });
	base.settings.stream = { deferred: true };
	base.faux.setResponses([fauxAssistantMessage("deferred answer")]);
	const fetching = deferred();
	let fetches = 0;
	const fetchDeferred: Models["fetchDeferred"] = (model, handle, options) => {
		fetches++;
		if (fetches > 1) return base.models.fetchDeferred(model, handle, options);
		fetching.resolve();
		return aborted(options!.signal!);
	};
	const models = new Proxy(base.models, {
		get(target, property) {
			if (property === "fetchDeferred") return fetchDeferred;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const setup: ChatSetup = { ...base, models };
	return { setup, fetching, fetches: () => fetches };
}

/** Submit to a fresh chat at `path`, let its deferred response be fetched, and crash during that fetch. */
async function crashWhilePolling(path: string, setup: ChatSetup, fetching: Promise<void>) {
	const opened = await open(path, setup);
	opened.harness.resume();
	const id = (await opened.root.submit({ type: "input", content: "hi" }, context)).id;
	await fetching;
	const taskId = (await live(opened.harness)).run!.taskId;
	expect((await opened.harness.getTask(taskId, context))?.state).toMatchObject({
		status: "running",
		checkpoint: { phase: "poll" },
	});
	opened.kill();
	return { id, taskId };
}

describe("crash edges (#11139)", () => {
	it("charges a crash during a poll's fetch, then polls the same deferred response again", async () => {
		const path = await sqlitePath();
		const { setup, fetching, fetches } = deferredSetup();
		setup.settings.retry = { enabled: true, maxRetries: 2, baseDelayMs: 1 };
		const { id, taskId } = await crashWhilePolling(path, setup, fetching.promise);

		const opened = await open(path, setup);
		const values = liveValues(opened.harness);
		expect((await opened.harness.getTask(taskId, context))?.restarts).toBe(1);
		opened.harness.resume();
		const answer = await settled(opened.harness, id);
		expect(answer.status).toBe("done");
		expect(values.find((value) => value.generation?.retry !== undefined)?.generation).toEqual({
			attempt: 1,
			retry: {
				at: expect.any(Number),
				error: "The host stopped while the deferred answer was fetched, on attempt 1",
			},
		});
		expect(values.some((value) => value.generation?.attempt === 2 && value.generation.deferred !== undefined)).toBe(
			true,
		);
		// One request, polled twice: the provider's job is neither dropped nor submitted again.
		expect(setup.faux.state.callCount).toBe(1);
		expect(fetches()).toBe(2);
		expect(setup.faux.state.cancelledDeferred).toEqual([]);
		const entries = await allEntries(opened.root);
		expect(textOf(entries.at(-1)!.model![0])).toBe("deferred answer");
		await opened.harness.close(context);
	});

	it("cancels the deferred response when a crash during its poll ends the run", async () => {
		const path = await sqlitePath();
		const { setup, fetching } = deferredSetup();
		setup.settings.retry = { enabled: false };
		const { id, taskId } = await crashWhilePolling(path, setup, fetching.promise);
		const opened = await open(path, setup);
		opened.harness.resume();
		const text = "The host stopped while the deferred answer was fetched, on attempt 1";
		expect(await settled(opened.harness, id)).toMatchObject({
			status: "unanswered",
			reason: "interrupted",
			detail: text,
		});
		expect(await live(opened.harness)).toEqual({
			runFailure: { taskId, inputs: [id], reason: "interrupted", detail: text, first: expect.any(Number) },
		});
		expect(setup.faux.state.cancelledDeferred).toHaveLength(1);
		await opened.harness.close(context);
	});

	it("charges an interrupted poll even when the clock moved backwards", async () => {
		const path = await sqlitePath();
		const { setup, fetching } = deferredSetup(10);
		let now = 1000;
		setup.now = () => now;
		setup.settings.retry = { enabled: false };
		const first = await open(path, setup);
		first.harness.resume();
		const id = (await first.root.submit({ type: "input", content: "hi" }, context)).id;
		await waitFor(async () => (await live(first.harness)).generation?.deferred !== undefined);
		now = 1010;
		first.harness.resume();
		await fetching.promise;
		first.kill();
		// A replacement host whose clock is behind: the poll looks not due yet, but its fetch was cut off.
		now = 1000;
		const opened = await open(path, setup);
		opened.harness.resume();
		expect(await settled(opened.harness, id)).toMatchObject({ status: "unanswered", reason: "interrupted" });
		await opened.harness.close(context);
	});

	it("charges a request once when a crash is followed by a clean close before the charge", async () => {
		const path = await sqlitePath();
		const first = streaming();
		first.settings.retry = { enabled: true, maxRetries: 3, baseDelayMs: 1 };
		const { id, taskId } = await crashWhileStreaming(path, first);
		const setup = chatSetup();
		setup.settings.retry = { enabled: true, maxRetries: 3, baseDelayMs: 1 };
		setup.faux.setResponses([fauxAssistantMessage("answer")]);
		let opened = await open(path, setup);
		await opened.harness.close(context);
		opened = await open(path, setup);
		expect((await opened.harness.getTask(taskId, context))?.restarts).toBe(1);
		const values = liveValues(opened.harness);
		opened.harness.resume();
		expect((await settled(opened.harness, id)).status).toBe("done");
		const charged = values.filter((value) => value.generation?.retry !== undefined);
		expect(charged.map((value) => value.generation?.attempt)).toEqual([1]);
		expect((await allEntries(opened.root)).map((entry) => entry.kind)).toEqual([
			"pi.user",
			"pi.assistant",
			"pi.assistant",
		]);
		await opened.harness.close(context);
	});

	it("ends a run restart_limit when charging the interrupted request keeps being cut off", async () => {
		const path = await sqlitePath();
		const first = streaming();
		first.settings.restartLimit = 1;
		const { id, taskId } = await crashWhileStreaming(path, first);
		// At the limit: the partial is still kept.
		const setup = chatSetup();
		setup.settings.restartLimit = 1;
		const opened = await open(path, setup);
		const partial = textOf((await live(opened.harness)).generation?.message as Message)!;
		opened.harness.resume();
		const text = "The generation was interrupted once in its request phase";
		expect(await settled(opened.harness, id)).toMatchObject({
			status: "unanswered",
			reason: "restart_limit",
			detail: text,
		});
		expect(await live(opened.harness)).toEqual({
			runFailure: { taskId, inputs: [id], reason: "restart_limit", detail: text, first: expect.any(Number) },
		});
		const entries = await allEntries(opened.root);
		expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
		expect(textOf(entries[1]!.model![0])).toBe(partial);
		expect(setup.faux.state.callCount).toBe(0);
		await opened.harness.close(context);
	});

	it("drops the partial past the limit, where converting it may be what keeps failing", async () => {
		const path = await sqlitePath();
		const first = streaming();
		const { id, taskId } = await crashWhileStreaming(path, first);
		// As if the charge had been cut off twice before: the open after this crash counts 3, past the limit of 2.
		const raw = await openNodeSqliteStorage(path);
		const record = await raw.task(taskId, context);
		await raw.commit([{ type: "task", value: { ...record!, restarts: 2 } }], () => {}, context);
		await raw.close(context);
		const setup = chatSetup();
		setup.settings.restartLimit = 2;
		const opened = await open(path, setup);
		opened.harness.resume();
		expect(await settled(opened.harness, id)).toMatchObject({
			status: "unanswered",
			reason: "restart_limit",
			detail: "The generation was interrupted 3 times in a row in its request phase",
		});
		expect((await allEntries(opened.root)).map((entry) => entry.kind)).toEqual(["pi.user"]);
		expect((await live(opened.harness)).generation).toBeUndefined();
		await opened.harness.close(context);
	});

	it("ends a run someone aborted as aborted when its abort handler is cut off restartLimit times", async () => {
		const path = await sqlitePath();
		const setup = chatSetup({ deferred: { pollAfterMs: 3_600_000 } });
		setup.settings.restartLimit = 2;
		setup.settings.stream = { deferred: true };
		setup.faux.setResponses([fauxAssistantMessage("never")]);
		let cancels = 0;
		// The abort handler of a polling generation cancels its response: make that hang.
		setup.models.cancelDeferred = () => {
			cancels++;
			return new Promise(() => {});
		};
		let opened = await open(path, setup);
		opened.harness.resume();
		const id = (await opened.root.submit({ type: "input", content: "hi" }, context)).id;
		const taskId = (await live(opened.harness)).run!.taskId;
		await waitFor(async () => (await opened.harness.getTask(taskId, context))?.state.status === "sleeping");
		void opened.root.abort(context).catch(() => {});
		for (let crash = 1; crash <= 2; crash++) {
			await waitFor(() => cancels === crash);
			opened.kill();
			opened = await open(path, setup);
			expect((await opened.harness.getTask(taskId, context))?.restarts).toBe(crash);
			opened.harness.resume();
		}
		const detail = `Abort handler of task ${taskId} (pi.generation) was cut off 2 times`;
		expect(await settled(opened.harness, id)).toMatchObject({ status: "unanswered", reason: "aborted", detail });
		expect(await live(opened.harness)).toEqual({
			runFailure: { taskId, inputs: [id], reason: "aborted", detail, first: expect.any(Number) },
		});
		expect((await opened.harness.waitForTask(taskId, context)).state.outcome).toMatchObject({
			status: "faulted",
			error: { detail: { reason: "restart_limit" } },
		});
		await waitFor(() => setup.infos.some((info) => info.kind === "task_faulted"));
		expect(setup.infos).toContainEqual(expect.objectContaining({ kind: "task_faulted", reason: "restart_limit" }));
		await opened.harness.close(context);
	});
});

describe("reports of work crashes ended (#11139)", () => {
	it("reports task_interrupted for a run that ends interrupted and for a task that ends at the limit", async () => {
		const path = await sqlitePath();
		const first = streaming();
		first.settings.retry = { enabled: false };
		const { taskId } = await crashWhileStreaming(path, first);
		const setup = chatSetup();
		setup.settings.retry = { enabled: false };
		const opened = await open(path, setup);
		opened.harness.resume();
		await opened.harness.waitForTask(taskId, context);
		await waitFor(() => setup.infos.length > 0);
		expect(setup.infos).toEqual([
			{
				kind: "task_interrupted",
				task: { id: taskId, kind: "pi.generation", conversationId: ROOT_CONVERSATION_ID },
				reason: "interrupted",
				restarts: 1,
			},
		]);
		expect(String(setup.reports[0])).toContain("The host stopped while the model was answering, on attempt 1");
		await opened.harness.close(context);
	});
});

describe("the restart limit on the normal path (#11139)", () => {
	it("resolves the settings no more often than before: only a task that was cut off reads the limit", async () => {
		const setup = chatSetup();
		let resolutions = 0;
		// Every resolution of the host settings reads `extensions` once.
		(setup as { settings: object }).settings = new Proxy(
			{},
			{
				get(target, key) {
					if (key === "extensions") resolutions++;
					return Reflect.get(target, key);
				},
			},
		);
		addTool(
			setup.registry,
			defineTool({
				name: "t",
				description: "t",
				parameters: Type.Object({}),
				replay: "safe",
				execute: async () => ({}),
			}),
		);
		const rounds = 5;
		const responses: FauxResponseStep[] = [];
		for (let round = 0; round <= rounds; round++) {
			responses.push(() =>
				fauxAssistantMessage([fauxToolCall("t", {}, { id: `c${round}` })], { stopReason: "toolUse" }),
			);
			responses.push(() => fauxAssistantMessage([fauxText("done")]));
		}
		setup.faux.setResponses(responses);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await (await root.submit({ type: "input", content: "warm up" }, context)).wait(context);
		resolutions = 0;
		for (let round = 0; round < rounds; round++) {
			await (await root.submit({ type: "input", content: `round ${round}` }, context)).wait(context);
		}
		// One generation round with one tool call, as before the restart limit applied to every kind (#11327: 49).
		expect(resolutions / rounds).toBe(49);
		await harness.close(context);
	});
});
