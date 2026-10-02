import {
	type AssistantMessage,
	fauxAssistantMessage,
	type Message,
	type Models,
	type SimpleStreamOptions,
	type SystemMessage,
} from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type CommitPublication,
	type Conversation,
	createRegistry,
	defineDoc,
	defineExtension,
	GenerationTask,
	Harness,
	type HarnessSettings,
	LiveDoc,
	type LiveState,
	MemoryStorage,
	type RegistrySnapshot,
	type TaskId,
	UserEntry,
	wrapSection,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { resolveSettings } from "../src/harness/agent.ts";
import type { SessionImpl } from "../src/session/session.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf, unanswered, waitFor } from "./chat-support.ts";
import { addSection } from "./harness-support.ts";
import { ControlledStorage, context } from "./session-support.ts";

const ERROR_503 = fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" });

async function live(harness: Harness, conversation: Conversation): Promise<Readonly<LiveState> | undefined> {
	return harness.snapshot(LiveDoc, conversation.id, context);
}

async function runTask(harness: Harness, conversation: Conversation): Promise<TaskId> {
	let taskId: TaskId | undefined;
	await waitFor(async () => {
		taskId = (await live(harness, conversation))?.run?.taskId;
		return taskId !== undefined;
	});
	return taskId!;
}

/** `models` with `streamSimple` replaced. */
function withStream(models: Models, streamSimple: Models["streamSimple"]): Models {
	return new Proxy(models, {
		get(target, property) {
			if (property === "streamSimple") return streamSimple;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * A stream that commits one partial and then ends with a final message that is not strict JSON, so the classification
 * commit throws and the scheduler faults the task.
 */
function invalidFinalStream(): ReturnType<Models["streamSimple"]> {
	const events = async function* () {
		yield { type: "start", partial: fauxAssistantMessage("partial", { stopReason: "pending" }) };
		await new Promise((resolve) => setTimeout(resolve, 300));
	};
	const final = { ...fauxAssistantMessage("final"), invalid: () => {} };
	return { [Symbol.asyncIterator]: events, result: async () => final } as unknown as ReturnType<
		Models["streamSimple"]
	>;
}

function livePublications(harness: Harness): LiveState[] {
	const values: LiveState[] = [];
	harness.subscribeCommits((publication: CommitPublication) => {
		for (const change of publication.changes) {
			if (change.type === "document" && change.record.kind === "pi.live" && change.value !== null) {
				values.push(change.value as LiveState);
			}
		}
	});
	return values;
}

describe("generation", () => {
	it("answers an input and settles its submission", async () => {
		const setup = chatSetup();
		addSection(setup.registry, "preamble", () => "You are helpful.", { tag: false });
		setup.faux.setResponses([fauxAssistantMessage("Hello there")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harness.resume();
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") throw new Error(`Unexpected ${settled.status}`);

		const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		expect(textOf(answer?.model?.[0])).toBe("Hello there");
		const entries = await allEntries(root);
		expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.system", "pi.assistant"]);
		expect(entries[0]!.id).toBe(settled.entry);
		expect(entries[1]!.model).toEqual([
			{ role: "system", content: "", sections: { preamble: "You are helpful." }, timestamp: expect.any(Number) },
		]);
		expect(await live(harness, root)).toEqual({});
		const task = (await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 10), context)).items[0];
		expect(task?.kind).toBe("pi.generation");
		// Entries written by the generation are attributed to it; the admitted user entry is not task work.
		expect(entries.map((entry) => entry.byTaskId)).toEqual([undefined, task!.id, task!.id]);
		expect(task?.state).toEqual({
			status: "terminal",
			outcome: { status: "completed", result: { entryId: settled.answer } },
		});
		await harness.close(context);
	});

	it("stores partials as deltas and a complete base once nothing is in flight", async () => {
		const setup = chatSetup({ tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } });
		setup.faux.setResponses([fauxAssistantMessage("w".repeat(200))]);
		const storage = new ControlledStorage();
		const { harness, root } = await openChat(storage, setup);
		const record = await storage.findDocument(
			{ kind: "pi.live", scope: { kind: "conversation", conversationId: root.id } },
			"current",
			context,
		);
		harness.resume();
		await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
		const contents = storage.commits.flatMap((writes) =>
			writes.flatMap((write) =>
				write.type === "document.change" && write.id === record!.id ? [write.content.kind] : [],
			),
		);
		// Streaming writes deltas; the commit that settles the answer clears generation and writes a base.
		expect(contents).toContain("delta");
		expect(contents.at(-1)).toBe("base");
		await harness.close(context);
	});

	it("still ends a run whose input something else already settled", async () => {
		const setup = chatSetup();
		const busy = unanswered();
		setup.faux.setResponses([busy.step]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await busy.reached;
		await root.commit(
			(tx) => tx.settleSubmission(submission.id, { status: "unanswered", reason: "withdrawn" }),
			context,
		);
		const taskId = await runTask(harness, root);
		await harness.abortTask(taskId, context);
		expect((await harness.waitForTask(taskId, context)).state.outcome).toEqual({ status: "aborted" });
		// The earlier settlement stays; the run's own settlement leaves it unchanged.
		expect(await submission.status(context)).toMatchObject({ status: "unanswered", reason: "withdrawn" });
		expect(await live(harness, root)).toEqual({});
		await harness.close(context);
	});

	it("fails with no_model when no model is configured or the model is unknown", async () => {
		const setup = chatSetup();
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const plain = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		harness.resume();
		const unset = await (await plain.submit({ type: "input", content: "hi" }, context)).wait(context);
		expect(unset).toMatchObject({ status: "unanswered", reason: "no_model" });

		await root.configure({ model: { provider: "faux", modelId: "missing" } }, context);
		const unknown = await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
		expect(unknown).toMatchObject({ status: "unanswered", reason: "no_model", entry: expect.any(Number) });
		expect((await allEntries(root)).map((entry) => entry.kind)).toEqual(["pi.user"]);
		const tasks = await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 10), context);
		expect(tasks.items[0]!.state).toEqual({
			status: "terminal",
			outcome: {
				status: "failed",
				error: { message: "Model faux/missing is not available", detail: { reason: "no_model" } },
			},
		});
		expect(await live(harness, root)).toEqual({});
		expect(await live(harness, plain)).toEqual({});
		await harness.close(context);
	});

	it("retries a retryable error after a durable backoff and then answers", async () => {
		const setup = chatSetup();
		addSection(setup.registry, "preamble", () => "p", { tag: false });
		setup.faux.setResponses([ERROR_503, fauxAssistantMessage("recovered")]);
		setup.settings.retry = { enabled: true, maxRetries: 3, baseDelayMs: 1 };
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const values = livePublications(harness);
		harness.resume();
		const settled = await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
		expect(settled.status).toBe("done");
		const entries = await allEntries(root);
		expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.system", "pi.assistant", "pi.assistant"]);
		expect((entries[2]!.model![0] as AssistantMessage).stopReason).toBe("error");
		expect(values.some((value) => value.generation?.retry?.error === "503 Service Unavailable")).toBe(true);
		expect(values.some((value) => value.generation?.attempt === 2)).toBe(true);
		expect(await live(harness, root)).toEqual({});
		await harness.close(context);
	});

	it("fails with model_error once retries are exhausted", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([ERROR_503, ERROR_503, fauxAssistantMessage("never")]);
		setup.settings.retry = { enabled: true, maxRetries: 1, baseDelayMs: 1 };
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harness.resume();
		const settled = await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "model_error", detail: "503 Service Unavailable" });
		expect((await allEntries(root)).map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant", "pi.assistant"]);
		expect(setup.faux.getPendingResponseCount()).toBe(1);
		await harness.close(context);
	});

	it("fails a retryable error without retrying when the retry policy is disabled", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([ERROR_503, fauxAssistantMessage("never")]);
		setup.settings.retry = { enabled: false };
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harness.resume();
		const settled = await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "model_error" });
		expect(setup.faux.state.callCount).toBe(1);
		await harness.close(context);
	});

	it("reports section wrapper failures while preparing", async () => {
		const setup = chatSetup();
		addSection(setup.registry, "cwd", () => "/repo");
		setup.registry.install(
			defineExtension({
				name: "broken",
				wraps: [
					wrapSection("cwd", () => {
						throw new Error("wrapper failed");
					}),
				],
			}),
		);
		setup.faux.setResponses([fauxAssistantMessage("ok")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harness.resume();
		expect((await (await root.submit({ type: "input", content: "hi" }, context)).wait(context)).status).toBe("done");
		expect(setup.reports).toContainEqual(new Error("wrapper failed"));
		// The failed section is absent, so nothing was rendered.
		expect((await allEntries(root)).map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
		await harness.close(context);
	});

	it("fails a non-retryable error without retrying", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "Invalid request" }),
			fauxAssistantMessage("never"),
		]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harness.resume();
		const settled = await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
		expect(settled).toMatchObject({ status: "unanswered", reason: "model_error", detail: "Invalid request" });
		const tasks = await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 10), context);
		expect(tasks.items[0]!.state).toMatchObject({
			outcome: { status: "failed", error: { message: "Invalid request", detail: { reason: "model_error" } } },
		});
		await harness.close(context);
	});

	it("polls a deferred response until it is ready", async () => {
		const setup = chatSetup({ deferred: { pendingFetches: 1, pollAfterMs: 1 } });
		setup.faux.setResponses([fauxAssistantMessage("deferred answer")]);
		setup.settings.stream = { deferred: true };
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const values = livePublications(harness);
		harness.resume();
		const settled = await (await root.submit({ type: "input", content: "hi" }, context)).wait(context);
		if (settled.status !== "done" || settled.type !== "input") throw new Error(`Unexpected ${settled.status}`);
		expect(setup.faux.state.deferredFetchCount).toBe(2);
		const pollTimes = values.flatMap((value) =>
			value.generation?.deferred === undefined ? [] : [value.generation.deferred.pollAt],
		);
		expect(pollTimes.length).toBe(2);
		expect(pollTimes[1]!).toBeGreaterThan(pollTimes[0]!);
		const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		expect(textOf(answer?.model?.[0])).toBe("deferred answer");
		await harness.close(context);
	});

	it("converts the committed partial when aborted during streaming", async () => {
		const setup = chatSetup({ tokensPerSecond: 20, tokenSize: { min: 1, max: 1 } });
		setup.faux.setResponses([fauxAssistantMessage("x".repeat(400))]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harness.resume();
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		const taskId = await runTask(harness, root);
		await waitFor(async () => textOf((await live(harness, root))?.generation?.message as Message) !== undefined);
		const partial = (await live(harness, root))!.generation!.message!;
		expect(await harness.abortTask(taskId, context)).toBe("marked");
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		const entries = await allEntries(root);
		expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
		const converted = entries[1]!.model![0] as AssistantMessage;
		expect(converted.stopReason).toBe("aborted");
		expect(textOf(converted)!.startsWith(textOf(partial as Message)!)).toBe(true);
		expect(await live(harness, root)).toEqual({});
		expect((await harness.waitForTask(taskId, context)).state.outcome).toEqual({ status: "aborted" });
		await harness.close(context);
	});

	it("cancels a deferred response when aborted during polling", async () => {
		const setup = chatSetup({ deferred: { pendingFetches: 100, pollAfterMs: 60_000 } });
		setup.faux.setResponses([fauxAssistantMessage("never")]);
		setup.settings.stream = { deferred: true };
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harness.resume();
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		const taskId = await runTask(harness, root);
		await waitFor(async () => (await live(harness, root))?.generation?.deferred !== undefined);
		await harness.abortTask(taskId, context);
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(setup.faux.state.cancelledDeferred).toHaveLength(1);
		expect(await live(harness, root)).toEqual({});
		await harness.close(context);
	});

	it("reports a failed deferred cancellation and still ends the run aborted", async () => {
		const base = chatSetup({ deferred: { pendingFetches: 100, pollAfterMs: 60_000 } });
		base.faux.setResponses([fauxAssistantMessage("never")]);
		const models = new Proxy(base.models, {
			get(target, property) {
				if (property === "cancelDeferred") return async () => Promise.reject(new Error("cancel failed"));
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const setup: ChatSetup = { ...base, models };
		setup.settings.stream = { deferred: true };
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		harness.resume();
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		const taskId = await runTask(harness, root);
		await waitFor(async () => (await live(harness, root))?.generation?.deferred !== undefined);
		await harness.abortTask(taskId, context);
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(setup.reports).toContainEqual(new Error("cancel failed"));
		expect(await live(harness, root)).toEqual({});
		await harness.close(context);
	});

	it("forwards stream options and the thinking level", async () => {
		const setup = chatSetup();
		const seen: (SimpleStreamOptions | undefined)[] = [];
		setup.faux.setResponses([
			(_context, options) => {
				seen.push(options);
				return fauxAssistantMessage("a");
			},
			(_context, options) => {
				seen.push(options);
				return fauxAssistantMessage("b");
			},
		]);
		setup.settings.stream = { timeoutMs: 1234, headers: { "x-test": "1" } };
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.configure({ thinkingLevel: "high" }, context);
		harness.resume();
		await (await root.submit({ type: "input", content: "one" }, context)).wait(context);
		// Both are read at the next preparation: the thinking level from pi.agent, the stream options live from settings.
		await root.configure({ thinkingLevel: null }, context);
		setup.settings.stream = { timeoutMs: 99 };
		await (await root.submit({ type: "input", content: "two" }, context)).wait(context);
		expect(seen[0]).toMatchObject({ timeoutMs: 1234, headers: { "x-test": "1" }, reasoning: "high" });
		expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
		expect(seen[1]!.reasoning).toBeUndefined();
		expect(seen[1]).toMatchObject({ timeoutMs: 99 });
		expect(seen[1]!.headers).toBeUndefined();
		await harness.close(context);
	});

	it("reads settings through getters at every decision", async () => {
		const setup = chatSetup();
		let timeoutMs = 111;
		const seen: (number | undefined)[] = [];
		setup.faux.setResponses([
			(_context, options) => {
				seen.push(options?.timeoutMs);
				// The user changes the setting while the first attempt runs.
				timeoutMs = 222;
				return ERROR_503;
			},
			(_context, options) => {
				seen.push(options?.timeoutMs);
				return fauxAssistantMessage("ok");
			},
		]);
		const settings: HarnessSettings = {
			get stream() {
				return { timeoutMs };
			},
			retry: { baseDelayMs: 1 },
		};
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models: setup.models, registry: setup.registry, settings },
			context,
		);
		const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		harness.resume();
		expect((await (await root.submit({ type: "input", content: "hi" }, context)).wait(context)).status).toBe("done");
		// The retry prepares again, so it resolves the settings again and sends the new timeout.
		expect(seen).toEqual([111, 222]);
		await harness.close(context);
	});

	it("resolves settings over the built-in defaults", () => {
		expect(resolveSettings(undefined)).toEqual({
			stream: {},
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000 },
			compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 },
			toolExecution: "parallel",
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
		});
		expect(resolveSettings({ retry: { enabled: false }, compaction: { backgroundTokens: 0 } })).toMatchObject({
			retry: { enabled: false, maxRetries: 3, baseDelayMs: 2000 },
			compaction: { enabled: true, backgroundTokens: 0 },
		});
	});

	it("renders sections that read conversation documents through input.read", async () => {
		const Agent = defineDoc<{ cwd: string; kind: string }>({
			kind: "test.agent",
			version: 1,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({ cwd: "/", kind: "main" }),
		});
		const setup = chatSetup();
		addSection(
			setup.registry,
			"cwd",
			async (input, ctx) => (await input.read.snapshot(Agent, input.conversationId, ctx))?.cwd,
		);
		addSection(setup.registry, "agents", async (input, ctx) =>
			(await input.read.snapshot(Agent, input.conversationId, ctx))?.kind === "sub" ? undefined : "Read AGENTS.md",
		);
		setup.faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		await root.commit(async (tx) => {
			(await tx.doc(Agent, root.id)).cwd = "/repo";
		}, context);
		const sub = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: { provider: "faux", modelId: "faux-1" } },
				init: async (tx, id) => {
					const agent = await tx.doc(Agent, id);
					agent.kind = "sub";
					agent.cwd = "/sub";
				},
			},
			context,
		);
		harness.resume();
		await (await root.submit({ type: "input", content: "one" }, context)).wait(context);
		await (await sub.submit({ type: "input", content: "two" }, context)).wait(context);
		const sections = async (conversation: Conversation) =>
			(await allEntries(conversation)).find((entry) => entry.kind === "pi.system")?.model?.[0];
		expect(await sections(root)).toMatchObject({
			sections: { cwd: "<cwd>\n/repo\n</cwd>", agents: "<agents>\nRead AGENTS.md\n</agents>" },
		});
		expect((await sections(sub)) as SystemMessage).toEqual({
			role: "system",
			content: "",
			sections: { cwd: "<cwd>\n/sub\n</cwd>" },
			timestamp: expect.any(Number),
		});
		await harness.close(context);
	});

	it("commits no partial for a response that turns deferred after an empty start event", async () => {
		const base = chatSetup();
		const handle = { provider: "faux", modelId: "faux-1", api: "faux", id: "handle-1", pollAfterMs: 60_000 };
		const deferredStream = (): ReturnType<Models["streamSimple"]> => {
			const events = async function* () {
				yield { type: "start", partial: fauxAssistantMessage([], { stopReason: "pending" }) };
				// Longer than the partial throttle: an empty partial would be committed here.
				await new Promise((resolve) => setTimeout(resolve, 300));
			};
			const final = fauxAssistantMessage([], { stopReason: "deferred", deferred: handle });
			return { [Symbol.asyncIterator]: events, result: async () => final } as unknown as ReturnType<
				Models["streamSimple"]
			>;
		};
		const setup: ChatSetup = { ...base, models: withStream(base.models, deferredStream) };
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const values = livePublications(harness);
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		await waitFor(async () => (await live(harness, root))?.generation?.deferred !== undefined);
		expect(values.some((value) => value.generation?.message !== undefined)).toBe(false);
		await harness.abortTask((await live(harness, root))!.run!.taskId, context);
		expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect((await allEntries(root)).map((entry) => entry.kind)).toEqual(["pi.user"]);
		await harness.close(context);
	});

	it("faults a run task, settling its inputs and converting the committed partial", async () => {
		const base = chatSetup();
		const setup: ChatSetup = { ...base, models: withStream(base.models, invalidFinalStream) };
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const values = livePublications(harness);
		harness.resume();
		const submission = await root.submit({ type: "input", content: "hi" }, context);
		expect(await submission.wait(context)).toMatchObject({
			status: "unanswered",
			reason: "faulted",
			detail: expect.stringContaining("non-JSON function"),
		});
		expect(values.some((value) => textOf(value.generation?.message as Message) === "partial")).toBe(true);
		const entries = await allEntries(root);
		expect(entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
		expect(entries[1]!.model![0]).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(textOf(entries[1]!.model![0])).toBe("partial");
		expect(await live(harness, root)).toEqual({});
		const tasks = await harness.commit((tx) => tx.scanTasks({ conversationId: root.id }, 10), context);
		expect(tasks.items[0]!.state).toMatchObject({ status: "terminal", outcome: { status: "faulted" } });
		await harness.close(context);
	});

	it("orphans a blocked run task with full run cleanup", async () => {
		const setup = chatSetup();
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		// A run whose task was stored by a newer generation definition this process cannot run.
		const { taskId, submissionId } = await (harness as unknown as SessionImpl).commitWith(async (tx) => {
			const entry = await tx.appendEntry(UserEntry, root.id, {
				model: [{ role: "user", content: "hi", timestamp: 1 }],
			});
			const submission = await tx.createSubmission({
				conversationId: root.id,
				type: "input",
				status: "placed",
				entry: entry.id,
			});
			const taskId = await tx.createTask(
				{ definition: { ...GenerationTask.definition, version: 2 } },
				{},
				{ ownership: { kind: "conversation" }, conversationId: root.id },
			);
			(await tx.doc(LiveDoc, root.id)).run = { taskId, inputs: [submission.id] };
			return { taskId, submissionId: submission.id };
		}, context);
		harness.resume();
		await expect(root.submit({ type: "input", content: "busy", whenBusy: "reject" }, context)).rejects.toThrow(
			"is busy",
		);
		expect(await harness.abortTask(taskId, context)).toBe("marked");
		expect((await harness.waitForTask(taskId, context)).state.outcome).toEqual({
			status: "orphaned",
			reason: "task_too_old",
		});
		expect(await (await harness.submission(submissionId, context))!.status(context)).toMatchObject({
			status: "unanswered",
			reason: "task_too_old",
		});
		expect(await live(harness, root)).toEqual({});
		await harness.close(context);
	});

	it("rejects a registry without the built-in tasks", async () => {
		const empty = createRegistry().snapshot();
		const snapshot: RegistrySnapshot = {
			installed: () => [],
			extension: () => undefined,
			tools: () => [],
			sections: () => [],
			tasks: () => empty.tasks().filter((task) => task.definition.name !== "pi.generation"),
			task: (name) => (name === "pi.generation" ? undefined : empty.task(name)),
		};
		await expect(
			Harness.open(
				new MemoryStorage(),
				{ models: chatSetup().models, registry: { snapshot: () => snapshot, subscribe: () => () => {} } },
				context,
			),
		).rejects.toThrow("Registry lacks built-in tasks pi.generation");
	});
});
