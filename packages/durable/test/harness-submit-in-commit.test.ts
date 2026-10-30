// Admission for hosts that must not start runs: `whenIdle: "reject"`, and `submit(tx, draft)` inside the caller's
// commit (#11149).
import { withTelemetry } from "@earendil-works/chord/context";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import {
	type Conversation,
	ConversationBusy,
	type ConversationHandle,
	ConversationIdle,
	defineDoc,
	defineTask,
	defineTool,
	Harness,
	InboxDoc,
	LiveDoc,
	MemoryStorage,
	ReadAfterWrite,
	type SubmissionId,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { describe, expect, it } from "vitest";
import { type ChatSetup, chatSetup, openChat, unanswered, waitFor } from "./chat-support.ts";
import { addTask, addTool } from "./harness-support.ts";
import { ControlledStorage, context } from "./session-support.ts";
import { deferred } from "./task-support.ts";

const MODEL = { provider: "faux", modelId: "faux-1" } as const;

const failure = (): AssistantMessage =>
	fauxAssistantMessage([], { stopReason: "error", errorMessage: "Invalid request" });

/** A host's own conversation document. */
const Sent = defineDoc<{ ids: number[] }>({
	checkpointWhen: () => false,
	kind: "test.sent",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ ids: [] }),
});

/** Open a chat whose run hangs until aborted, and wait until it works on its first input. */
async function openBusy(storage = new ControlledStorage()) {
	const setup = chatSetup();
	const busy = unanswered();
	setup.faux.setResponses([busy.step]);
	const opened = await openChat(storage, setup);
	const first = await opened.root.submit({ type: "input", content: "work" }, context);
	await busy.reached;
	return { ...opened, storage, first };
}

/** Open a chat whose Harness records telemetry. */
async function openTraced(setup: ChatSetup, telemetry: InMemoryTelemetryContext) {
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: setup.models, registry: setup.registry, settings: setup.settings, telemetry },
		context,
	);
	const root = await harness.root(context, { agent: { model: MODEL } });
	return { harness, root };
}

/** Install tool `hold`, which reports its call and waits for `release`; its first call answers `tool`. */
function addHold(setup: ChatSetup) {
	const reached = deferred();
	const release = deferred();
	addTool(
		setup.registry,
		defineTool({
			name: "hold",
			description: "Holds until released",
			parameters: Type.Object({}),
			execute: async () => {
				reached.resolve();
				await release.promise;
				return { output: [] };
			},
		}),
	);
	const call = fauxAssistantMessage([fauxToolCall("hold", {}, { id: "c1" })], { stopReason: "toolUse" });
	return { reached, release, call };
}

/** Settled status of submission `id`, polled without asking for progress (`Submission.wait()` would). */
async function settledStatus(harness: Harness, id: SubmissionId) {
	const submission = (await harness.submission(id, context))!;
	await waitFor(async () => {
		const { status } = await submission.status(context);
		return status === "done" || status === "unanswered";
	});
	return submission.status(context);
}

describe("whenIdle reject", () => {
	// #11149
	it("rejects input to an idle conversation without writing", async () => {
		const storage = new ControlledStorage();
		const { harness, root } = await openChat(storage, chatSetup());
		const commits = storage.commits.length;
		const rejected = root.submit({ type: "input", content: "hi", whenBusy: "steer", whenIdle: "reject" }, context);
		await expect(rejected).rejects.toBeInstanceOf(ConversationIdle);
		await expect(rejected).rejects.toMatchObject({ conversationId: root.id });
		expect(storage.commits.length).toBe(commits);
		expect((await harness.snapshot(LiveDoc, root.id, context))?.run).toBeUndefined();
		await harness.close(context);
	});

	// #11149
	it("rejects input to an idle conversation that keeps queued items after a failed run", async () => {
		const setup = chatSetup();
		const failing = deferred();
		const requested = deferred();
		setup.faux.setResponses([
			async () => {
				requested.resolve();
				await failing.promise;
				return failure();
			},
		]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		const first = await root.submit({ type: "input", content: "first" }, context);
		await requested.promise;
		const queued = await root.submit({ type: "input", content: "queued" }, context);
		failing.resolve();
		expect(await first.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
		await harness.waitForIdle(context);
		const rejected = root.submit({ type: "input", content: "steer", whenBusy: "steer", whenIdle: "reject" }, context);
		await expect(rejected).rejects.toBeInstanceOf(ConversationIdle);
		expect(await queued.status(context)).toMatchObject({ status: "queued" });
		expect((await harness.snapshot(LiveDoc, root.id, context))?.run).toBeUndefined();
		await harness.close(context);
	});

	// #11149
	it("steers a working run", async () => {
		const { harness, root, first } = await openBusy();
		const steer = await root.submit(
			{ type: "input", content: "also this", whenBusy: "steer", whenIdle: "reject" },
			context,
		);
		expect(await steer.status(context)).toMatchObject({ type: "input", status: "queued" });
		const inbox = await harness.snapshot(InboxDoc, root.id, context);
		expect(inbox?.items).toEqual([{ id: steer.id, mode: "steer", content: "also this" }]);
		expect((await harness.snapshot(LiveDoc, root.id, context))?.run?.inputs).toEqual([first.id]);
		await harness.close(context);
	});

	// #11149
	it("returns the submission of a known request ID, also once idle", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		const first = await root.submit({ type: "input", content: "work", requestId: "r1" }, context);
		await first.wait(context);
		const draft = { type: "input", content: "work", requestId: "r1", whenBusy: "steer", whenIdle: "reject" } as const;
		expect((await root.submit(draft, context)).id).toBe(first.id);
		// Deduplication runs before the idle rejection in the caller's commit too.
		expect(await harness.commit((tx) => root.submit(tx, draft), context)).toBe(first.id);
		await harness.close(context);
	});

	// #11149
	it("rejects through a tool's conversation handle", async () => {
		const setup = chatSetup();
		let other: Conversation | undefined;
		let rejection: unknown;
		addTool(
			setup.registry,
			defineTool({
				name: "nudge",
				description: "Steers another conversation",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					const handle = (await api.conversation(other!.id, callContext))!;
					const draft = { type: "input", content: "nudge", whenBusy: "steer", whenIdle: "reject" } as const;
					rejection = await handle.submit(draft, callContext).catch((error: unknown) => error);
					return { output: [{ type: "text", text: "nudged" }] };
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("nudge", {}, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("ok")]),
		]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		other = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL } }, context);
		await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(rejection).toBeInstanceOf(ConversationIdle);
		expect((await harness.snapshot(LiveDoc, other.id, context))?.run).toBeUndefined();
		await harness.close(context);
	});
});

describe("submit inside the caller's commit", () => {
	// #11149
	it("admits with the host's own check and writes in one commit", async () => {
		const { harness, root, storage, first } = await openBusy();
		const commits = storage.commits.length;
		const id = await harness.commit(async (tx) => {
			if ((await tx.doc(LiveDoc, root.id)).run === undefined) throw new Error("not working");
			// The host's own document write may come before the admission.
			const sent = await tx.doc(Sent, root.id);
			const admitted = await root.submit(tx, { type: "input", content: "steer", whenBusy: "steer" });
			sent.ids.push(admitted);
			// The host's own table write comes after it.
			await tx.appendEntry(root.id, { kind: "app.sent", data: { submission: admitted } });
			return admitted;
		}, context);
		expect(storage.commits.length).toBe(commits + 1);
		const writes = storage.commits.at(-1)!;
		expect(writes.some((write) => write.type === "submission" && write.value.id === id)).toBe(true);
		expect(writes.some((write) => write.type === "entry" && write.value.kind === "app.sent")).toBe(true);
		expect((await harness.snapshot(Sent, root.id, context))?.ids).toEqual([id]);
		const inbox = await harness.snapshot(InboxDoc, root.id, context);
		expect(inbox?.items).toEqual([{ id, mode: "steer", content: "steer" }]);
		expect((await harness.snapshot(LiveDoc, root.id, context))?.run?.inputs).toEqual([first.id]);
		await harness.close(context);
	});

	// #11149
	it("is rolled back with the commit when the callback throws later", async () => {
		const storage = new ControlledStorage();
		const { harness, root } = await openChat(storage, chatSetup());
		const commits = storage.commits.length;
		const failed = harness.commit(async (tx) => {
			await root.submit(tx, { type: "input", content: "hi", requestId: "r1" });
			throw new Error("host check failed");
		}, context);
		await expect(failed).rejects.toThrow("host check failed");
		expect(storage.commits.length).toBe(commits);
		expect((await harness.snapshot(LiveDoc, root.id, context))?.run).toBeUndefined();
		expect(await harness.commit((tx) => tx.submissionByRequest(root.id, "r1"), context)).toBeUndefined();
		await harness.close(context);
	});

	// #11149
	it("leaves no submission and no run when Storage fails the commit, also after reopening", async () => {
		const storage = new ControlledStorage();
		const setup = chatSetup();
		const { harness, root } = await openChat(storage, setup);
		const failure = new Error("disk full");
		storage.failNextCommit(failure);
		const failed = harness.commit(async (tx) => {
			await root.submit(tx, { type: "input", content: "hi", requestId: "r1" });
			await tx.appendEntry(root.id, { kind: "app.sent" });
		}, context);
		await expect(failed).rejects.toBe(failure);
		await harness.closed;
		const reopened = await openChat(storage.reopen(), setup);
		expect(reopened.root.id).toBe(root.id);
		const found = await reopened.harness.commit(async (tx) => {
			const submission = await tx.submissionByRequest(root.id, "r1");
			const tasks = await tx.scanTasks({ conversationId: root.id }, 10);
			const entries = await tx.scanEntries({ conversationId: root.id }, 10);
			return { submission, tasks: tasks.items, entries: entries.items };
		}, context);
		expect(found).toEqual({ submission: undefined, tasks: [], entries: [] });
		expect((await reopened.harness.snapshot(LiveDoc, root.id, context))?.run).toBeUndefined();
		await reopened.harness.close(context);
	});

	// #11149
	it("starts the run of an idle input once the commit is stored", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([fauxAssistantMessage([fauxText("answer")])]);
		// No `resume()`: the admission asks for progress itself.
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		const id = await harness.commit((tx) => root.submit(tx, { type: "input", content: "hi" }), context);
		expect(await settledStatus(harness, id)).toMatchObject({ type: "input", status: "done" });
		await harness.close(context);
	});

	// #11149
	it("queues a model-visible write while busy and places it at the next boundary", async () => {
		const setup = chatSetup();
		const hold = addHold(setup);
		setup.faux.setResponses([hold.call, fauxAssistantMessage([fauxText("answer")])]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		const first = await root.submit({ type: "input", content: "work" }, context);
		await hold.reached.promise;
		const note = { role: "user", content: "a note the model sees", timestamp: 1 } as const;
		const id = await harness.commit(
			(tx) => root.submit(tx, { type: "write", entry: { kind: "test.note", model: [note] } }),
			context,
		);
		expect((await harness.snapshot(InboxDoc, root.id, context))?.items.map((item) => item.id)).toEqual([id]);
		hold.release.resolve();
		expect(await first.wait(context)).toMatchObject({ status: "done" });
		expect(await settledStatus(harness, id)).toMatchObject({
			type: "write",
			status: "done",
			entry: expect.any(Number),
		});
		await harness.close(context);
	});

	// #11149
	it("deduplicates request IDs", async () => {
		const { harness, root, storage } = await openBusy();
		const draft = { type: "input", content: "steer", whenBusy: "steer", requestId: "r1" } as const;
		const first = await harness.commit((tx) => root.submit(tx, draft), context);
		const commits = storage.commits.length;
		const again = await harness.commit((tx) => root.submit(tx, draft), context);
		expect(again).toBe(first);
		expect(storage.commits.length).toBe(commits);
		await harness.close(context);
	});

	// #11149
	it("rejects before any write, so the callback may catch the rejection", async () => {
		const storage = new ControlledStorage();
		const { harness, root } = await openChat(storage, chatSetup());
		const commits = storage.commits.length;
		const outcome = await harness.commit(async (tx) => {
			try {
				await root.submit(tx, { type: "input", content: "hi", whenBusy: "steer", whenIdle: "reject" });
				return "admitted";
			} catch (error) {
				return error instanceof ConversationIdle ? "idle" : "other";
			}
		}, context);
		expect(outcome).toBe("idle");
		expect(storage.commits.length).toBe(commits);
		expect((await harness.snapshot(LiveDoc, root.id, context))?.run).toBeUndefined();
		await harness.close(context);
	});

	// #11149
	it("throws ReadAfterWrite after a table write of the commit, on every path", async () => {
		const { harness, root } = await openBusy();
		// A busy input without request ID or trace reads no table, and is still refused.
		const afterAppend = harness.commit(async (tx) => {
			await tx.appendEntry(root.id, { kind: "app.note" });
			await root.submit(tx, { type: "input", content: "steer", whenBusy: "steer" });
		}, context);
		await expect(afterAppend).rejects.toBeInstanceOf(ReadAfterWrite);
		await expect(afterAppend).rejects.toThrow("submit(tx, draft) cannot read tables after the first table write");
		const second = harness.commit(async (tx) => {
			await root.submit(tx, { type: "input", content: "one", whenBusy: "steer" });
			await root.submit(tx, { type: "input", content: "two", whenBusy: "steer" });
		}, context);
		await expect(second).rejects.toBeInstanceOf(ReadAfterWrite);
		expect((await harness.snapshot(InboxDoc, root.id, context))?.items).toEqual([]);

		const idle = await openChat(new ControlledStorage(), chatSetup());
		const late = idle.harness.commit(async (tx) => {
			await tx.appendEntry(idle.root.id, { kind: "app.note" });
			await idle.root.submit(tx, { type: "input", content: "hi" });
		}, context);
		await expect(late).rejects.toBeInstanceOf(ReadAfterWrite);
		await idle.harness.close(context);
		await harness.close(context);
	});

	// #11149
	it("continues a failed run, and must precede the commit's table writes", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([failure, fauxAssistantMessage([fauxText("recovered")])]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		const first = await root.submit({ type: "input", content: "Analyze this" }, context);
		expect(await first.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });

		const late = harness.commit(async (tx) => {
			await tx.appendEntry(root.id, { kind: "app.note" });
			await root.submit(tx, { type: "continue" });
		}, context);
		await expect(late).rejects.toBeInstanceOf(ReadAfterWrite);

		const id = await harness.commit(async (tx) => {
			const continued = await root.submit(tx, { type: "continue" });
			await tx.appendEntry(root.id, { kind: "app.note" });
			return continued;
		}, context);
		expect(await settledStatus(harness, id)).toMatchObject({ type: "continue", status: "done" });
		await harness.close(context);
	});

	// #11149
	it("rejects a busy continue and steers with whenIdle inside the commit", async () => {
		const { harness, root } = await openBusy();
		const busy = harness.commit((tx) => root.submit(tx, { type: "continue" }), context);
		await expect(busy).rejects.toBeInstanceOf(ConversationBusy);
		const steer = await harness.commit(
			(tx) => root.submit(tx, { type: "input", content: "steer", whenBusy: "steer", whenIdle: "reject" }),
			context,
		);
		expect((await harness.snapshot(InboxDoc, root.id, context))?.items.map((item) => item.id)).toEqual([steer]);
		await harness.close(context);
	});

	// #11149
	it("throws for a transaction of another Session, or a wrapped one", async () => {
		const a = await openChat(new ControlledStorage(), chatSetup());
		const b = await openChat(new ControlledStorage(), chatSetup());
		const draft = { type: "input", content: "hi" } as const;
		const foreign = b.harness.commit((tx) => a.root.submit(tx, draft), context);
		await expect(foreign).rejects.toThrow("The transaction belongs to another Session");
		const proxied = a.harness.commit((tx) => a.root.submit(new Proxy(tx, {}), draft), context);
		await expect(proxied).rejects.toThrow("The transaction belongs to another Session");
		const plain = a.harness.commit((tx) => a.root.submit({ doc: tx.doc.bind(tx) } as unknown as Tx, draft), context);
		await expect(plain).rejects.toThrow("The transaction belongs to another Session");
		expect((await a.harness.snapshot(LiveDoc, a.root.id, context))?.run).toBeUndefined();
		await a.harness.close(context);
		await b.harness.close(context);
	});

	// #11149
	it("records the trace carrier and links a steer to its caller and the running trace", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const busy = unanswered();
		setup.faux.setResponses([busy.step]);
		const { harness, root } = await openTraced(setup, telemetry);
		await root.submit({ type: "input", content: "work" }, context);
		await busy.reached;
		const run = (await harness.inspect(context)).tasks.find((task) => task.record.kind === "pi.generation")!.record;
		const id = await telemetry.startSpan({ name: "caller" }, (caller) =>
			harness.commit(
				(tx) => root.submit(tx, { type: "input", content: "steer", whenBusy: "steer" }),
				withTelemetry(caller, context),
			),
		);
		const spans = telemetry.getSpans();
		const caller = spans.find((span) => span.name === "caller")!;
		const submit = spans.find(
			(span) => span.name === "pi.durable.submit" && span.attributes["submission.id"] === id,
		)!;
		expect(submit).toMatchObject({ parentId: null, attributes: { result: "queued" } });
		expect(submit.links).toEqual([
			{ context: caller.context, attributes: {} },
			{ context: run.trace, attributes: {} },
		]);
		expect((await (await harness.submission(id, context))!.status(context)).trace).toEqual(submit.context);
		await harness.close(context);
	});

	// #11149
	it("starts an idle input's run in the admission's trace", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const busy = unanswered();
		setup.faux.setResponses([busy.step]);
		const { harness, root } = await openTraced(setup, telemetry);
		const id = await telemetry.startSpan({ name: "caller" }, (caller) =>
			harness.commit((tx) => root.submit(tx, { type: "input", content: "hi" }), withTelemetry(caller, context)),
		);
		await busy.reached;
		const submit = telemetry
			.getSpans()
			.find((span) => span.name === "pi.durable.submit" && span.attributes["submission.id"] === id)!;
		const record = await (await harness.submission(id, context))!.status(context);
		expect(record.trace).toEqual(submit.context);
		const run = (await harness.inspect(context)).tasks.find((task) => task.record.kind === "pi.generation")!.record;
		expect(run.trace).toEqual(record.trace);
		await harness.close(context);
	});

	// #11149
	it("makes a write a child of its caller and leaves the commit's events to the caller's commit", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const { harness, root } = await openTraced(setup, telemetry);
		const id = await telemetry.startSpan({ name: "caller" }, (caller) =>
			harness.commit(
				(tx) => root.submit(tx, { type: "write", entry: { kind: "app.note" } }),
				withTelemetry(caller, context),
			),
		);
		const spans = telemetry.getSpans();
		const caller = spans.find((span) => span.name === "caller")!;
		const submit = spans.find((span) => span.name === "pi.durable.submit")!;
		expect(submit).toMatchObject({
			parentContext: caller.context,
			settled: true,
			attributes: { "submission.id": id, result: "done" },
			events: [],
		});
		expect(caller.events.map((event) => event.name)).toEqual(["pi.durable.entry", "pi.durable.submission"]);
		await harness.close(context);
	});

	// #11149
	it("ends its span before the commit, and a later throw leaves no submission", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const { harness, root } = await openTraced(setup, telemetry);
		await telemetry.startSpan({ name: "caller" }, async (caller) => {
			const failed = harness.commit(
				async (tx) => {
					await root.submit(tx, { type: "write", entry: { kind: "app.note" } });
					throw new Error("later");
				},
				withTelemetry(caller, context),
			);
			await expect(failed).rejects.toThrow("later");
		});
		const spans = telemetry.getSpans();
		const submit = spans.find((span) => span.name === "pi.durable.submit")!;
		// The span reported an admission the commit then discarded.
		expect(submit).toMatchObject({ settled: true, attributes: { result: "done" } });
		const id = submit.attributes["submission.id"] as SubmissionId;
		expect(await harness.submission(id, context)).toBeUndefined();
		expect(spans.find((span) => span.name === "caller")!.events).toEqual([]);
		await harness.close(context);
	});

	// #11149
	it("admits atomically from a tool's commit through its conversation handle", async () => {
		const setup = chatSetup();
		let other: Conversation | undefined;
		let toolTask: number | undefined;
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "Delegates to another conversation",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					toolTask = api.taskId;
					const handle = (await api.conversation(other!.id, callContext))!;
					const id = await api.commit(async (tx) => {
						const admitted = await handle.submit(tx, { type: "input", content: "from the tool" });
						await tx.appendEntry(other!.id, { kind: "app.delegated", data: { submission: admitted } });
						return admitted;
					}, callContext);
					return { output: [{ type: "text", text: `submitted ${id}` }] };
				},
			}),
		);
		const reply: FauxResponseStep = (request) => {
			const last = request.messages.at(-1);
			if (last?.role === "user" && last.content === "delegate") {
				return fauxAssistantMessage([fauxToolCall("delegate", {}, { id: "c1" })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage([fauxText("ok")]);
		};
		setup.faux.setResponses([reply, reply, reply]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		other = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL } }, context);
		const run = await root.submit({ type: "input", content: "delegate" }, context);
		expect(await run.wait(context)).toMatchObject({ status: "done" });
		await harness.waitForIdle(context);
		const entries = [...(await other.entries({}, 100, undefined, context)).items].reverse();
		const delegated = entries.find((entry) => entry.kind === "app.delegated");
		const submission = (delegated?.data as { submission: SubmissionId }).submission;
		const settled = await settledStatus(harness, submission);
		if (settled.type !== "input" || settled.status !== "done") throw new Error(`Unexpected ${settled.status}`);
		// The placed input carries the tool task's byTaskId, as the commit's own appends do.
		const user = await other.commit((tx) => tx.entry(UserEntry, settled.entry), context);
		expect(user?.byTaskId).toBe(toolTask);
		await harness.close(context);
	});

	// #11149
	it("admits inside a task's terminal commit", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([fauxAssistantMessage([fauxText("answer")])]);
		const Admitting = defineTask<null, { phase: "run" }, SubmissionId>({
			name: "test.admitting",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					const handle = (await runtime.conversation(runtime.conversationId, taskContext))!;
					await runtime.commit(async (tx) => {
						const id = await handle.submit(tx, { type: "input", content: "from the task" });
						return { status: "terminal", outcome: { status: "completed", result: id } };
					}, taskContext);
				},
			},
			abort: (_task, runtime, taskContext) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
		});
		addTask(setup.registry, Admitting);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		const task = await root.commit(
			(tx) => tx.createTask(Admitting, null, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		const settled = await harness.waitForTask(task, context);
		if (settled.state.outcome.status !== "completed") throw new Error(settled.state.outcome.status);
		const status = await settledStatus(harness, settled.state.outcome.result);
		if (status.type !== "input" || status.status !== "done") throw new Error(`Unexpected ${status.status}`);
		const user = await root.commit((tx) => tx.entry(UserEntry, status.entry), context);
		expect(user?.byTaskId).toBe(task);
		await harness.close(context);
	});

	// #11149
	it("rejects through a handle once its invocation is aborted, and once it ended", async () => {
		const setup = chatSetup();
		let other: Conversation | undefined;
		let handle: ConversationHandle | undefined;
		const started = deferred();
		const abortSeen = deferred();
		const release = deferred();
		addTool(
			setup.registry,
			defineTool({
				name: "hold",
				description: "Holds until released, also when aborted",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					handle = (await api.conversation(other!.id, callContext))!;
					callContext.abortSignal!.addEventListener("abort", () => abortSeen.resolve(), { once: true });
					started.resolve();
					await release.promise;
					return { output: [] };
				},
			}),
		);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {}, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("ok")]),
		]);
		const { harness, root } = await openChat(new ControlledStorage(), setup);
		other = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL } }, context);
		const run = await root.submit({ type: "input", content: "go" }, context);
		await started.promise;
		const tool = (await harness.inspect(context)).tasks.find((task) => task.record.kind === "pi.tool")!.record;
		const aborting = harness.abortTask(tool.id, context);
		await abortSeen.promise;
		const draft = { type: "input", content: "late" } as const;
		await expect(handle!.submit(draft, context)).rejects.toThrow();
		await expect(harness.commit((tx) => handle!.submit(tx, draft), context)).rejects.toThrow();
		expect((await harness.snapshot(LiveDoc, other.id, context))?.run).toBeUndefined();
		release.resolve();
		await aborting;
		await run.wait(context);
		await expect(harness.commit((tx) => handle!.submit(tx, draft), context)).rejects.toThrow();
		expect((await harness.snapshot(LiveDoc, other.id, context))?.run).toBeUndefined();
		await harness.close(context);
	});
});
