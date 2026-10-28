import { withTelemetry } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
	CompactionTask,
	defineTask,
	defineTool,
	GenerationTask,
	Harness,
	MemoryStorage,
	type Storage,
	type TaskId,
} from "@earendil-works/pi-durable";
import {
	InMemoryTelemetryContext,
	NOOP_TELEMETRY_CONTEXT,
	NOOP_TELEMETRY_METRICS,
	type TelemetryContext,
} from "@earendil-works/pi-telemetry";
import { describe, expect, it, vi } from "vitest";
import { createCodemodeTool } from "../src/codemode/codemode.ts";
import { type ChatSetup, chatSetup, waitFor } from "./chat-support.ts";
import { addHooks, addTask, addTool } from "./harness-support.ts";
import { ControlledStorage, context, flush, onValue } from "./session-support.ts";
import { aborted, openTasks } from "./task-support.ts";

async function openTracked(storage: Storage, setup: ChatSetup, telemetry: InMemoryTelemetryContext) {
	const harness = await Harness.open(
		storage,
		{
			models: setup.models,
			registry: setup.registry,
			settings: setup.settings,
			now: () => setup.now(),
			telemetry,
			onReport: ({ error }) => setup.reports.push(error),
		},
		context,
	);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	return { harness, root };
}

const toolReply = (name: string, args: Record<string, string> = {}) =>
	fauxAssistantMessage([fauxToolCall(name, args, { id: "call-1" })], { stopReason: "toolUse" });

describe("Durable telemetry", () => {
	it("records content-free submit and phase spans, nested parents, checkpoints, entry events, and metrics", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		addTool(
			setup.registry,
			defineTool({
				name: "inner",
				description: "inner",
				parameters: Type.Object({ secret: Type.String() }),
				execute: async () => ({ output: [{ type: "text", text: "private-result" }] }),
			}),
		);
		addTool(
			setup.registry,
			defineTool({
				name: "outer",
				description: "outer",
				parameters: Type.Object({}),
				execute: async (_args, api, ctx) => {
					await api.executeTool("inner", { secret: "private-argument" }, ctx);
					return { output: [{ type: "text", text: "private-output" }] };
				},
			}),
		);
		setup.faux.setResponses([toolReply("outer"), fauxAssistantMessage("private-answer")]);
		const { harness, root } = await openTracked(new MemoryStorage(), setup, telemetry);
		const submitted = await root.submit({ type: "input", content: "private-input", requestId: "dedupe" }, context);
		await submitted.wait(context);
		await harness.waitForIdle(context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		const record = await submitted.status(context);
		const again = await root.submit(
			{ type: "input", content: "another-private-input", requestId: "dedupe" },
			context,
		);
		expect(await again.status(context)).toEqual(record);
		const spans = telemetry.getSpans();
		const submit = spans.find((span) => span.name === "pi.durable.submit")!;
		expect(submit).toMatchObject({ parentId: null, attributes: { "submission.id": submitted.id, result: "placed" } });
		expect(record.trace).toEqual(submit.context);
		const phases = spans.filter((span) => span.name === "pi.durable.phase");
		expect(phases.length).toBeGreaterThan(4);
		const requests = spans.filter((span) => span.name === "pi.ai.request");
		expect(requests).toHaveLength(2);
		for (const request of requests)
			expect(phases.find((phase) => phase.id === request.parentId)?.attributes.phase).toBe("request");
		expect(phases[0]).toMatchObject({
			parentContext: submit.context,
			attributes: { phase: "prepare", resumed: false, outcome: "next=request" },
		});
		const outer = phases.find((span) => span.attributes["tool.name"] === "outer")!;
		const inner = phases.find((span) => span.attributes["tool.name"] === "inner")!;
		expect(inner.parentContext).toEqual(outer.context);
		expect(outer.attributes).toMatchObject({ phase: "call", outcome: "done", "tool.call_id": "call-1" });
		expect(outer.events).toContainEqual({ name: "pi.durable.checkpoint", attributes: { phase: "execute" } });
		expect(phases.some((span) => span.attributes.outcome === "waiting")).toBe(true);
		expect(submit.events).toContainEqual({
			name: "pi.durable.entry",
			attributes: { "entry.id": record.entry, "entry.kind": "pi.user" },
		});
		expect(phases.flatMap((span) => span.events)).toContainEqual({
			name: "pi.durable.submission",
			attributes: { "submission.id": submitted.id, status: "done", "answer.entry_id": record.answer },
		});
		const recorded = JSON.stringify(spans.map(({ attributes, events }) => ({ attributes, events })));
		for (const content of [
			"private-input",
			"private-answer",
			"private-output",
			"private-result",
			"private-argument",
			"secret",
			"gen_ai",
		])
			expect(recorded).not.toContain(content);
		await harness.close(context);
		const metrics = telemetry.getMetrics();
		expect(metrics.filter((metric) => metric.name === "pi.durable.phase.duration")).toHaveLength(phases.length);
		expect(
			metrics
				.filter((metric) => metric.name === "pi.durable.tasks.active")
				.reduce((sum, metric) => sum + metric.value, 0),
		).toBe(0);
		for (const metric of metrics.filter((metric) => metric.name.startsWith("pi.durable.")))
			expect(Object.keys(metric.attributes).some((key) => key.includes("id"))).toBe(false);
		expect(setup.reports).toEqual([]);
	});

	it("returns admission results without re-reading records or probing root link targets", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const storage = new ControlledStorage();
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		setup.faux.setResponses([
			async () => {
				reached.resolve();
				await gate.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("second"),
		]);
		const { harness, root } = await openTracked(storage, setup, telemetry);
		const reads = vi.spyOn(storage, "submission");
		const inject = vi.spyOn(telemetry.propagation, "inject");
		const extract = vi.spyOn(telemetry.propagation, "extract");
		const ctx = context;
		const first = await root.submit({ type: "input", content: "first" }, ctx);
		await reached.promise;
		const second = await root.submit({ type: "input", content: "second", requestId: "queued" }, ctx);
		const duplicate = await root.submit({ type: "input", content: "ignored", requestId: "queued" }, ctx);
		expect(duplicate.id).toBe(second.id);
		expect(reads).not.toHaveBeenCalled();
		expect(inject.mock.calls.some(([target]) => target === telemetry)).toBe(false);
		expect(extract.mock.calls.some(([carrier]) => carrier === undefined)).toBe(false);
		expect(
			telemetry
				.getSpans()
				.filter((span) => span.name === "pi.durable.submit")
				.map((span) => span.attributes.result),
		).toEqual(["placed", "queued", "queued"]);
		reads.mockRestore();
		inject.mockRestore();
		extract.mockRestore();
		gate.resolve();
		await first.wait(context);
		await second.wait(context);
		await harness.close(context);
	});

	it("inherits omitted or undefined task traces and stores no carrier for an explicit root", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const Task = defineTask<null, { phase: "finish" }, null>({
			name: "test.trace",
			version: 1,
			initial: () => ({ phase: "finish" }),
			phases: {
				finish: async (_task, runtime, ctx) => {
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
						ctx,
					);
				},
			},
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		addTask(setup.registry, Task);
		const { harness, root } = await openTracked(new MemoryStorage(), setup, telemetry);
		const ids = await telemetry.startSpan({ name: "creator" }, (span) =>
			root.commit(
				async (tx) => [
					await tx.createTask(Task, null, { ownership: { kind: "conversation" } }),
					await tx.createTask(Task, null, { ownership: { kind: "conversation" }, trace: undefined }),
					await tx.createTask(Task, null, { ownership: { kind: "conversation" }, trace: "root" }),
				],
				withTelemetry(span, context),
			),
		);
		for (const id of ids) await harness.waitForTask(id, context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		const creator = telemetry.getSpans()[0]!;
		const records = await Promise.all(ids.map((id) => harness.getTask(id, context)));
		expect(records.map((record) => record!.trace)).toEqual([creator.context, creator.context, undefined]);
		const phases = telemetry.getSpans().filter((span) => span.name === "pi.durable.phase");
		expect(phases.map((span) => span.parentContext)).toEqual([creator.context, creator.context, null]);
		await harness.close(context);
	});

	it("records checkpoints only when the running phase changes", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const Task = defineTask<null, { phase: "call" | "finish"; count: number }, null>({
			name: "test.checkpoint",
			version: 1,
			initial: () => ({ phase: "call", count: 0 }),
			phases: {
				call: async (_task, runtime, ctx) => {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "call", count: 1 } }), ctx);
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "call", count: 2 } }), ctx);
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "finish", count: 2 } }), ctx);
				},
				finish: async (_task, runtime, ctx) => {
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
						ctx,
					);
				},
			},
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		addTask(setup.registry, Task);
		const { harness, root } = await openTracked(new MemoryStorage(), setup, telemetry);
		const id = await root.commit((tx) => tx.createTask(Task, null, { ownership: { kind: "conversation" } }), context);
		await harness.waitForTask(id, context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		expect(
			telemetry
				.getSpans()
				.flatMap((span) => span.events)
				.filter((event) => event.name === "pi.durable.checkpoint"),
		).toEqual([{ name: "pi.durable.checkpoint", attributes: { phase: "finish" } }]);
		await harness.close(context);
	});

	it("starts each queued input's run in its admission trace and links input roots to their caller", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		setup.faux.setResponses([
			async () => {
				reached.resolve();
				await gate.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("second"),
		]);
		const { harness, root } = await openTracked(new MemoryStorage(), setup, telemetry);
		await telemetry.startSpan({ name: "caller" }, async (caller) => {
			const ctx = withTelemetry(caller, context);
			const first = await root.submit({ type: "input", content: "first" }, ctx);
			await reached.promise;
			const second = await root.submit({ type: "input", content: "second" }, ctx);
			expect((await second.status(ctx)).status).toBe("queued");
			gate.resolve();
			await first.wait(ctx);
			await second.wait(ctx);
		});
		await harness.waitForIdle(context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		const spans = telemetry.getSpans();
		const caller = spans.find((span) => span.name === "caller")!;
		const submits = spans.filter((span) => span.name === "pi.durable.submit");
		expect(submits).toHaveLength(2);
		for (const submit of submits) {
			expect(submit.parentId).toBeNull();
			expect(submit.links).toEqual([{ context: caller.context, attributes: {} }]);
			expect(
				spans.some(
					(span) =>
						span.name === "pi.durable.phase" &&
						span.attributes.phase === "prepare" &&
						JSON.stringify(span.parentContext) === JSON.stringify(submit.context),
				),
			).toBe(true);
		}
		expect(submits[0]!.context).not.toEqual(submits[1]!.context);
		await harness.close(context);
	});

	it("links the other queued inputs to the first invocation of their shared run", async () => {
		const setup = chatSetup();
		setup.settings.followUpMode = "all";
		const telemetry = new InMemoryTelemetryContext();
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		setup.faux.setResponses([
			async () => {
				reached.resolve();
				await gate.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("shared"),
		]);
		const { harness, root } = await openTracked(new MemoryStorage(), setup, telemetry);
		const first = await root.submit({ type: "input", content: "first" }, context);
		await reached.promise;
		const second = await root.submit({ type: "input", content: "second" }, context);
		const third = await root.submit({ type: "input", content: "third" }, context);
		const secondTrace = (await second.status(context)).trace;
		const thirdTrace = (await third.status(context)).trace;
		gate.resolve();
		await first.wait(context);
		await second.wait(context);
		await third.wait(context);
		await harness.waitForIdle(context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		const tasks = await harness.commit((tx) => tx.scanTasks({ kind: "pi.generation" }, 10), context);
		expect(tasks.items[1]).toMatchObject({ trace: secondTrace, links: [thirdTrace] });
		const phases = telemetry
			.getSpans()
			.filter((span) => span.name === "pi.durable.phase" && span.attributes["task.id"] === tasks.items[1]!.id);
		expect(phases.map((span) => span.attributes.phase)).toEqual(["prepare", "request"]);
		for (const phase of phases) expect(phase.links).toEqual([{ context: thirdTrace, attributes: {} }]);
		await harness.close(context);
	});

	it("links a steer admission to the current run without moving its work into the steer's trace", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		addTool(
			setup.registry,
			defineTool({
				name: "hold",
				description: "hold",
				parameters: Type.Object({}),
				execute: async () => {
					reached.resolve();
					await gate.promise;
					return { output: [] };
				},
			}),
		);
		setup.faux.setResponses([toolReply("hold"), fauxAssistantMessage("answer")]);
		const { harness, root } = await openTracked(new MemoryStorage(), setup, telemetry);
		const first = await root.submit({ type: "input", content: "first" }, context);
		await reached.promise;
		const run = (await harness.inspect(context)).tasks.find((task) => task.record.kind === "pi.generation")!.record;
		const steer = await root.submit({ type: "input", content: "steer", whenBusy: "steer" }, context);
		const steerTrace = (await steer.status(context)).trace;
		const steerSpan = telemetry.getSpans().find((span) => span.attributes["submission.id"] === steer.id)!;
		expect(steerSpan).toMatchObject({ parentId: null, links: [{ context: run.trace, attributes: {} }] });
		gate.resolve();
		await first.wait(context);
		await steer.wait(context);
		await harness.waitForIdle(context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		expect(
			telemetry
				.getSpans()
				.filter((span) => span.name === "pi.durable.phase")
				.some((span) => JSON.stringify(span.parentContext) === JSON.stringify(steerTrace)),
		).toBe(false);
		await harness.close(context);
	});

	it("keeps a public write admission open through commit as a child of its caller", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const storage = new ControlledStorage();
		const { harness, root } = await openTracked(storage, setup, telemetry);
		await telemetry.startSpan({ name: "caller" }, async (caller) => {
			const held = storage.holdCommits();
			const writing = root.submit(
				{ type: "write", entry: { kind: "app.note", data: "private-note" } },
				withTelemetry(caller, context),
			);
			await held.entered;
			const inFlight = telemetry.getSpans().find((span) => span.name === "pi.durable.submit")!;
			expect(inFlight).toMatchObject({ settled: false, events: [] });
			held.release();
			const submission = await writing;
			const record = await submission.status(context);
			const span = telemetry.getSpans().find((span) => span.name === "pi.durable.submit")!;
			expect(span).toMatchObject({
				parentContext: telemetry.getSpans()[0]!.context,
				settled: true,
				attributes: { result: "done" },
			});
			expect(record.trace).toEqual(span.context);
			expect(span.events.map((event) => event.name)).toEqual(["pi.durable.entry", "pi.durable.submission"]);
		});
		await harness.close(context);
	});

	it("links an input submitted inside a turn to the calling phase without parenting it", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		addTool(
			setup.registry,
			defineTool({
				name: "delegate",
				description: "delegate",
				parameters: Type.Object({}),
				execute: async (_args, api, ctx) => {
					const child = await api.commit(
						(tx) => tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } }),
						ctx,
					);
					const conversation = (await api.conversation(child.id, ctx))!;
					await (await conversation.submit({ type: "input", content: "child" }, ctx)).wait(ctx);
					return { output: [] };
				},
			}),
		);
		setup.faux.setResponses([
			toolReply("delegate"),
			fauxAssistantMessage("child answer"),
			fauxAssistantMessage("parent answer"),
		]);
		const { harness, root } = await openTracked(new MemoryStorage(), setup, telemetry);
		await (await root.submit({ type: "input", content: "parent" }, context)).wait(context);
		await harness.waitForIdle(context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		const spans = telemetry.getSpans();
		const tool = spans.find((span) => span.attributes["tool.name"] === "delegate")!;
		const child = spans.filter((span) => span.name === "pi.durable.submit")[1]!;
		expect(child.parentId).toBeNull();
		expect(child.links).toEqual([{ context: tool.context, attributes: {} }]);
		await harness.close(context);
	});

	it("parents background compaction to the prepare phase that creates it", async () => {
		const setup = chatSetup({ models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }] });
		setup.settings.compaction = { enabled: true, reserveTokens: 300, keepRecentTokens: 150, backgroundTokens: 1000 };
		const telemetry = new InMemoryTelemetryContext();
		addHooks(setup.registry, CompactionTask, { beforeCompact: () => ({ decline: true }) });
		setup.faux.setResponses([fauxAssistantMessage("done")]);
		const { harness, root } = await openTracked(new MemoryStorage(), setup, telemetry);
		await root.commit(async (tx) => {
			await tx.appendEntry(root.id, {
				kind: "pi.user",
				model: [{ role: "user", content: "x".repeat(400), timestamp: 1 }],
			});
			await tx.appendEntry(root.id, { kind: "pi.assistant", model: [fauxAssistantMessage("y".repeat(400))] });
		}, context);
		await (await root.submit({ type: "input", content: "z".repeat(400) }, context)).wait(context);
		await harness.waitForIdle(context);
		await waitFor(() =>
			telemetry.getSpans().some((span) => span.attributes["task.name"] === "pi.compaction" && span.settled),
		);
		const spans = telemetry.getSpans();
		const prepare = spans.find(
			(span) => span.attributes["task.name"] === "pi.generation" && span.attributes.phase === "prepare",
		)!;
		const compaction = spans.find((span) => span.attributes["task.name"] === "pi.compaction")!;
		expect(compaction.parentContext).toEqual(prepare.context);
		const tasks = await harness.commit((tx) => tx.scanTasks({ kind: "pi.compaction" }, 10), context);
		expect(tasks.items[0]).toMatchObject({ background: true, trace: prepare.context });
		await harness.close(context);
	});

	it("marks only the first invocation after reopen resumed, retaining its stored parent", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const storage = new ControlledStorage();
		let recover = false;
		const reached = Promise.withResolvers<void>();
		const Task = defineTask<null, { phase: "hold" } | { phase: "finish" }, null>({
			name: "test.resume",
			version: 1,
			initial: () => ({ phase: "hold" }),
			phases: {
				hold: async (_task, runtime, ctx) => {
					if (!recover) {
						reached.resolve();
						await aborted(ctx.abortSignal!);
					}
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "finish" } }), ctx);
				},
				finish: async (_task, runtime, ctx) => {
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
						ctx,
					);
				},
			},
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		addTask(setup.registry, Task);
		let { harness, root } = await openTracked(storage, setup, telemetry);
		let id!: TaskId<null>;
		await telemetry.startSpan({ name: "creator" }, async (span) => {
			id = await root.commit(
				(tx) => tx.createTask(Task, null, { ownership: { kind: "conversation" } }),
				withTelemetry(span, context),
			);
		});
		harness.resume();
		await reached.promise;
		const before = (await harness.getTask(id, context))!;
		await harness.close(context);
		recover = true;
		const reopenedTelemetry = new InMemoryTelemetryContext();
		({ harness, root } = await openTracked(storage.reopen(), setup, reopenedTelemetry));
		await harness.waitForTask(id, context);
		await waitFor(() => reopenedTelemetry.getSpans().every((span) => span.settled));
		const phases = [...telemetry.getSpans(), ...reopenedTelemetry.getSpans()].filter(
			(span) => span.name === "pi.durable.phase",
		);
		expect(phases.map((span) => span.attributes.resumed)).toEqual([false, true, false]);
		expect(phases[0]!.attributes.outcome).toBe("aborted");
		expect(phases[0]!.status).toEqual({ status: "ok" });
		for (const phase of phases) expect(phase.parentContext).toEqual(before.trace);
		await harness.close(context);
		expect(
			[...telemetry.getMetrics(), ...reopenedTelemetry.getMetrics()]
				.filter((metric) => metric.name === "pi.durable.tasks.active")
				.map((metric) => metric.value),
		).toEqual([1, -1, 1, -1]);
	});

	it("emits entry and settlement events only after successful storage commits", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const storage = new ControlledStorage();
		const { harness, root } = await openTracked(storage, setup, telemetry);
		await telemetry.startSpan({ name: "caller" }, async (span) => {
			const ctx = withTelemetry(span, context);
			await expect(
				root.commit(async (tx) => {
					await tx.appendEntry(root.id, { kind: "app.rolled-back", data: "private-rolled-back" });
					throw new Error("rollback");
				}, ctx),
			).rejects.toThrow("rollback");
			expect(telemetry.getSpans()[0]!.events).toEqual([]);
			const held = storage.holdCommits();
			const writing = root.commit(
				(tx) => tx.appendEntry(root.id, { kind: "app.note", data: "private-content" }),
				ctx,
			);
			await held.entered;
			expect(telemetry.getSpans()[0]!.events).toEqual([]);
			held.release();
			const entry = await writing;
			const submission = await root.commit(
				(tx) => tx.createSubmission({ conversationId: root.id, type: "write", status: "done", entry: entry.id }),
				ctx,
			);
			expect(telemetry.getSpans()[0]!.events).toEqual([
				{ name: "pi.durable.entry", attributes: { "entry.id": entry.id, "entry.kind": "app.note" } },
				{ name: "pi.durable.submission", attributes: { "submission.id": submission.id, status: "done" } },
			]);
		});
		await harness.close(context);
	});

	it("records internal compaction admissions as phase events without a submit span", async () => {
		const setup = chatSetup();
		setup.settings.compaction = { keepRecentTokens: 1 };
		const telemetry = new InMemoryTelemetryContext();
		const storage = new ControlledStorage();
		let held: ReturnType<ControlledStorage["holdCommits"]> | undefined;
		addHooks(setup.registry, CompactionTask, {
			beforeCompact: () => {
				held = storage.holdCommits();
				return { summary: "private-summary" };
			},
		});
		const { harness, root } = await openTracked(storage, setup, telemetry);
		await root.commit(async (tx) => {
			await tx.appendEntry(root.id, { kind: "pi.user", model: [{ role: "user", content: "old", timestamp: 1 }] });
			await tx.appendEntry(root.id, { kind: "pi.assistant", model: [fauxAssistantMessage("answer")] });
		}, context);
		const id = await root.compact(undefined, context);
		await waitFor(() => held !== undefined);
		await held!.entered;
		expect(telemetry.getSpans().some((span) => span.name === "pi.durable.submit")).toBe(false);
		expect(telemetry.getSpans().find((span) => span.attributes["task.name"] === "pi.compaction")).toMatchObject({
			settled: false,
			events: [],
		});
		held!.release();
		await harness.waitForTask(id, context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		const spans = telemetry.getSpans();
		const phase = spans.find((span) => span.attributes["task.name"] === "pi.compaction")!;
		expect(spans.some((span) => span.name === "pi.durable.submit")).toBe(false);
		expect(phase.events.some((event) => event.name === "pi.durable.entry")).toBe(true);
		expect(
			phase.events.some((event) => event.name === "pi.durable.submission" && event.attributes.status === "done"),
		).toBe(true);
		expect(JSON.stringify(spans)).not.toContain("private-summary");
		await harness.close(context);
	});

	it.each(["faulted", "failed", "orphaned"] as const)(
		"records a fixed %s category and a bounded diagnostic",
		async (status) => {
			const setup = chatSetup();
			const telemetry = new InMemoryTelemetryContext();
			const message = "diagnostic ".repeat(80);
			const Task = defineTask<null, { phase: "fail" }, null>({
				name: "test.fault",
				version: 1,
				initial: () => ({ phase: "fail" }),
				phases: {
					fail: async (_task, runtime, ctx) => {
						if (status === "faulted") {
							const error = new Error(message);
							error.name = "private-exception-name";
							throw error;
						}
						await runtime.commit(
							() => ({
								status: "terminal",
								outcome:
									status === "orphaned"
										? { status, reason: message }
										: { status, error: { message, detail: "private-error-detail" } },
							}),
							ctx,
						);
					},
				},
				abort: async (_task, runtime, ctx) => {
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
				},
			});
			addTask(setup.registry, Task);
			const { harness, root } = await openTracked(new MemoryStorage(), setup, telemetry);
			const id = await root.commit(
				(tx) => tx.createTask(Task, null, { ownership: { kind: "conversation" }, trace: { unknown: "carrier" } }),
				context,
			);
			const record = await harness.waitForTask(id, context);
			expect(record.state.outcome).toMatchObject(
				status === "orphaned" ? { status, reason: message } : { status, error: { message } },
			);
			await waitFor(() => telemetry.getSpans().every((span) => span.settled));
			const span = telemetry.getSpans().find((span) => span.name === "pi.durable.phase")!;
			expect(span).toMatchObject({ parentId: null, attributes: { outcome: "faulted" } });
			expect(span.status).toEqual({
				status: "error",
				error: { name: `task_${status}`, message: message.slice(0, 500) },
			});
			if (status === "faulted")
				expect(span.events).toContainEqual({
					name: "pi.durable.report",
					attributes: { type: "task_faulted", reason: "threw", extension: "task:test.fault", "task.id": id },
				});
			expect(JSON.stringify(span)).not.toContain("private-exception-name");
			expect(JSON.stringify(span)).not.toContain("private-error-detail");
			expect(JSON.stringify({ attributes: span.attributes, events: span.events })).not.toContain("diagnostic");
			await harness.close(context);
		},
	);

	it("keeps both interrupted runs and explicit abort handlers at status ok", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const reached = Promise.withResolvers<void>();
		const Task = defineTask<null, { phase: "hold" }, null>({
			name: "test.abort",
			version: 1,
			initial: () => ({ phase: "hold" }),
			phases: {
				hold: async (_task, _runtime, ctx) => {
					reached.resolve();
					await aborted(ctx.abortSignal!);
				},
			},
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "aborted", reason: "private-abort-reason" } }),
					ctx,
				);
			},
		});
		addTask(setup.registry, Task);
		const { harness, root } = await openTracked(new MemoryStorage(), setup, telemetry);
		const id = await root.commit((tx) => tx.createTask(Task, null, { ownership: { kind: "conversation" } }), context);
		harness.resume();
		await reached.promise;
		await harness.abortTask(id, context);
		await harness.waitForTask(id, context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		const phases = telemetry.getSpans().filter((span) => span.name === "pi.durable.phase");
		expect(phases.map((span) => span.attributes.kind)).toEqual(["run", "abort"]);
		for (const span of phases) {
			expect(span.attributes.outcome).toBe("aborted");
			expect(span.status).toEqual({ status: "ok" });
		}
		expect(JSON.stringify(phases)).not.toContain("private-abort-reason");
		await harness.close(context);
	});

	it("mirrors runtime reports as fixed-field phase events and type-only counters", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const error = new Error("private-report-payload");
		const Task = defineTask<null, { phase: "report" }, null>({
			name: "test.report",
			version: 1,
			initial: () => ({ phase: "report" }),
			phases: {
				report: async (_task, runtime, ctx) => {
					runtime.report(error);
					runtime.report(error, { kind: "extension", extension: "reporting-extension" });
					runtime.report(error, { kind: "host", callback: "models" });
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
						ctx,
					);
				},
			},
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		addTask(setup.registry, Task);
		const { harness, root } = await openTracked(new MemoryStorage(), setup, telemetry);
		const id = await root.commit((tx) => tx.createTask(Task, null, { ownership: { kind: "conversation" } }), context);
		await harness.waitForTask(id, context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		const span = telemetry.getSpans().find((span) => span.name === "pi.durable.phase")!;
		expect(span.events).toEqual([
			{
				name: "pi.durable.report",
				attributes: { type: "task_error", extension: "task:test.report", "task.id": id },
			},
			{
				name: "pi.durable.report",
				attributes: { type: "extension_error", extension: "reporting-extension", "task.id": id },
			},
			{ name: "pi.durable.report", attributes: { type: "host_error", "task.id": id } },
		]);
		expect(setup.reports).toEqual([error, error, error]);
		expect(telemetry.getSpans().some((span) => span.name === "pi.durable.report")).toBe(false);
		expect(
			telemetry
				.getMetrics()
				.filter((metric) => metric.name === "pi.durable.reports")
				.map(({ attributes, value }) => ({ attributes, value })),
		).toEqual([
			{ attributes: { type: "task_error" }, value: 1 },
			{ attributes: { type: "extension_error" }, value: 1 },
			{ attributes: { type: "host_error" }, value: 1 },
		]);
		expect(JSON.stringify(telemetry.getSpans())).not.toContain("private-report-payload");
		await harness.close(context);
	});

	it("reports hook failures on the phase and clock failures without a phase context", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const hookError = new Error("private-hook-error");
		addHooks(
			setup.registry,
			GenerationTask,
			{
				beforeRequest: () => {
					throw hookError;
				},
			},
			"reporting-hooks",
		);
		setup.faux.setResponses([fauxAssistantMessage("answer")]);
		const { harness, root } = await openTracked(new MemoryStorage(), setup, telemetry);
		await (await root.submit({ type: "input", content: "input" }, context)).wait(context);
		await harness.waitForIdle(context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		const request = telemetry
			.getSpans()
			.find((span) => span.name === "pi.durable.phase" && span.attributes.phase === "request")!;
		expect(request.events).toContainEqual({
			name: "pi.durable.report",
			attributes: {
				type: "extension_error",
				extension: "reporting-hooks",
				"task.id": request.attributes["task.id"],
			},
		});
		const clockError = new Error("private-clock-error");
		const Task = defineTask<null, { phase: "clock" }, null>({
			name: "test.clock",
			version: 1,
			initial: () => ({ phase: "clock" }),
			phases: {
				clock: async (_task, runtime, ctx) => {
					setup.now = () => {
						throw clockError;
					};
					runtime.now();
					setup.now = Date.now;
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
						ctx,
					);
				},
			},
			abort: async (_task, runtime, ctx) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});
		addTask(setup.registry, Task);
		const id = await root.commit((tx) => tx.createTask(Task, null, { ownership: { kind: "conversation" } }), context);
		await harness.waitForTask(id, context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		const clock = telemetry.getSpans().find((span) => span.attributes["task.name"] === "test.clock")!;
		expect(clock.events).toEqual([]);
		expect(telemetry.getSpans().some((span) => span.name === "pi.durable.report")).toBe(false);
		expect(
			telemetry
				.getMetrics()
				.filter((metric) => metric.name === "pi.durable.reports")
				.map((metric) => metric.attributes),
		).toEqual([{ type: "extension_error" }, { type: "host_error" }]);
		expect(setup.reports).toEqual([hookError, clockError]);
		expect(JSON.stringify(telemetry.getSpans())).not.toContain("private-hook-error");
		expect(JSON.stringify(telemetry.getSpans())).not.toContain("private-clock-error");
		await harness.close(context);
	});

	it("counts an outside-span session failure without starting a span", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const storage = new ControlledStorage();
		const { harness, root } = await openTracked(storage, setup, telemetry);
		const error = new Error("private-storage-error");
		storage.failNextCommit(error);
		await expect(root.commit((tx) => tx.appendEntry(root.id, { kind: "app.failed" }), context)).rejects.toBe(error);
		await harness.closed;
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		expect(setup.reports).toEqual([error]);
		expect(telemetry.getSpans()).toEqual([]);
		expect(JSON.stringify(telemetry.getMetrics())).not.toContain("private-storage-error");
		expect(
			telemetry
				.getMetrics()
				.filter((metric) => metric.name === "pi.durable.reports")
				.map((metric) => metric.attributes),
		).toEqual([{ type: "storage_failed" }]);
	});

	it("counts reports raised with a NOOP span without creating a root", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const { harness, root } = await openTracked(new MemoryStorage(), setup, telemetry);
		const error = new Error("private-noop-report");
		const observation = harness.observeCommits({
			advance: () => {
				throw error;
			},
			end: () => {},
		});
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "app.note" }), context);
		expect(setup.reports).toEqual([error]);
		expect(telemetry.getSpans()).toEqual([]);
		expect(
			telemetry
				.getMetrics()
				.filter((metric) => metric.name === "pi.durable.reports")
				.map((metric) => metric.attributes),
		).toEqual([{ type: "listener_error" }]);
		observation.detach();
		await harness.close(context);
	});

	it("attaches synchronous commit-listener reports to the active submission span", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		setup.faux.setResponses([fauxAssistantMessage("answer")]);
		const { harness, root } = await openTracked(new MemoryStorage(), setup, telemetry);
		const error = new Error("private-listener-error");
		const observation = harness.observeCommits({
			advance: (publication) => {
				if (publication.changes.some((change) => change.type === "entry" && change.value.kind === "pi.user"))
					throw error;
			},
			end: () => {},
		});
		await (await root.submit({ type: "input", content: "input" }, context)).wait(context);
		await harness.waitForIdle(context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		expect(setup.reports).toEqual([error]);
		const span = telemetry.getSpans().find((span) => span.name === "pi.durable.submit")!;
		expect(span.events).toContainEqual({ name: "pi.durable.report", attributes: { type: "listener_error" } });
		expect(JSON.stringify(telemetry.getSpans())).not.toContain("private-listener-error");
		observation.detach();
		await harness.close(context);
	});

	it("preserves async listener error containment and report counting", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		setup.faux.setResponses([fauxAssistantMessage("answer")]);
		const { harness, root } = await openTracked(new MemoryStorage(), setup, telemetry);
		const failed = Promise.withResolvers<void>();
		const observation = harness.observeCommits({
			advance: (publication) => {
				if (publication.changes.some((change) => change.type === "entry" && change.value.kind === "pi.user"))
					return failed.promise;
			},
			end: () => {},
		});
		await (await root.submit({ type: "input", content: "input" }, context)).wait(context);
		await harness.waitForIdle(context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		const error = new Error("private-async-listener-error");
		failed.reject(error);
		await waitFor(() => setup.reports.length === 1 && telemetry.getSpans().every((span) => span.settled));
		expect(setup.reports).toEqual([error]);
		expect(
			telemetry
				.getMetrics()
				.filter((metric) => metric.name === "pi.durable.reports")
				.map((metric) => metric.attributes),
		).toEqual([{ type: "listener_error" }]);
		expect(JSON.stringify(telemetry.getSpans())).not.toContain("private-async-listener-error");
		observation.detach();
		await harness.close(context);
	});

	it("emits replay for a codemode journal result without rerunning its nested tool", async () => {
		const setup = chatSetup();
		const telemetry = new InMemoryTelemetryContext();
		const storage = new ControlledStorage();
		const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
		let runs = 0;
		let recover = false;
		const reached = Promise.withResolvers<void>();
		addTool(setup.registry, createCodemodeTool({ sandbox, models: false }));
		addTool(
			setup.registry,
			defineTool({
				name: "once",
				description: "once",
				parameters: Type.Object({}),
				execute: async () => {
					runs++;
					return { output: [] };
				},
			}),
		);
		addTool(
			setup.registry,
			defineTool({
				name: "hold",
				description: "hold",
				replay: "safe",
				parameters: Type.Object({}),
				execute: async (_args, _api, ctx) => {
					if (!recover) {
						reached.resolve();
						await aborted(ctx.abortSignal!);
					}
					return { output: [] };
				},
			}),
		);
		setup.faux.setResponses([
			toolReply("codemode", { code: "await tools.once({}); await tools.hold({});" }),
			fauxAssistantMessage("done"),
		]);
		let { harness } = await openTracked(storage, setup, telemetry);
		const root = await harness.root(context);
		const submission = await root.submit({ type: "input", content: "run" }, context);
		await reached.promise;
		await harness.close(context);
		recover = true;
		({ harness } = await openTracked(storage.reopen(), setup, telemetry));
		await (await harness.submission(submission.id, context))!.wait(context);
		await harness.waitForIdle(context);
		await waitFor(() => telemetry.getSpans().every((span) => span.settled));
		expect(runs).toBe(1);
		expect(
			telemetry
				.getSpans()
				.flatMap((span) => span.events)
				.filter((event) => event.name === "pi.durable.replay"),
		).toContainEqual({ name: "pi.durable.replay", attributes: { "tool.name": "once" } });
		await harness.close(context);
		await sandbox.close();
	});

	it("reports telemetry adapters that throw while a commit is published, and the commit stands", async () => {
		const Idle = defineTask<null, { phase: "run" }, null>({
			name: "test.telemetry-idle",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: { run: async () => {} },
			abort: async () => {},
		});
		const throwingMetric = {
			add: () => {
				throw new Error("metrics down");
			},
		};
		const telemetry: TelemetryContext = {
			...NOOP_TELEMETRY_CONTEXT,
			metrics: { ...NOOP_TELEMETRY_METRICS, upDownCounter: () => throwingMetric },
		};
		const { harness, infos } = await openTasks(new MemoryStorage(), [Idle], { telemetry });
		const root = await harness.root(context);
		const view = await root.watch(context);
		const shown: (number | undefined)[] = [];
		view.start(
			onValue(async ({ value }) => {
				shown.push(value.entries.at(-1)?.id);
			}),
		);
		const hosts: number[] = [];
		harness.observeCommits({
			advance: (publication) => {
				hosts.push(publication.seq);
			},
			end: () => {},
		});
		const failing = withTelemetry(
			{
				...NOOP_TELEMETRY_CONTEXT,
				addEvent: () => {
					throw new Error("telemetry down");
				},
			},
			context,
		);
		const { entry, task } = await root.commit(async (tx) => {
			const entry = await tx.appendEntry(root.id, { kind: "note", data: {} });
			const task = await tx.createTask(Idle, null, { ownership: { kind: "conversation" } });
			return { entry: entry.id, task };
		}, failing);
		// The entry event, then the active-task metric; the report's own event throws too and is dropped.
		expect(infos).toEqual([
			{ kind: "host_error", callback: "telemetry" },
			{ kind: "host_error", callback: "telemetry" },
		]);
		expect(hosts).toHaveLength(1);
		await flush();
		expect(shown).toEqual([entry]);
		expect((await harness.getTask(task, context))?.state.status).toBe("pending");
		await view.stop();
		await harness.close(context);
		expect(await harness.closed).toEqual({ kind: "closed" });
	});

	it("drops a report's own metric that throws, after onReport got the report", async () => {
		const throwingCounter = {
			add: () => {
				throw new Error("metrics down");
			},
		};
		const telemetry: TelemetryContext = {
			...NOOP_TELEMETRY_CONTEXT,
			metrics: { ...NOOP_TELEMETRY_METRICS, counter: () => throwingCounter },
		};
		const { harness, reports, infos } = await openTasks(new MemoryStorage(), [], { telemetry });
		const root = await harness.root(context);
		const bug = new Error("listener bug");
		harness.observeCommits({
			advance: () => {
				throw bug;
			},
			end: () => {},
		});
		await root.commit((tx) => tx.appendEntry(root.id, { kind: "note", data: {} }), context);
		// The listener runs in the commit's dispatch microtask; a throw escaping its report would be unhandled there.
		await flush();
		expect(reports).toEqual([bug]);
		expect(infos).toEqual([{ kind: "listener_error" }]);
		await harness.close(context);
		expect(await harness.closed).toEqual({ kind: "closed" });
	});
});
