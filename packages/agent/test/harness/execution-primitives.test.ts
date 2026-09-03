import { fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	BACKGROUND_CONTEXT,
	createContextKey,
	getTelemetryContext,
	withAbortSignal,
	withContextValue,
	withTelemetryContext,
} from "../../src/harness/context.ts";
import { HarnessEventBus } from "../../src/harness/events.ts";
import { AbortRequested, createGate } from "../../src/harness/execution/effect-gate.ts";
import { HookRegistry } from "../../src/harness/hooks.ts";
import { InMemoryTelemetryContext } from "../../src/index.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

describe("createGate", () => {
	it("closes starts synchronously and signals only after cancellation commits", async () => {
		const { gate, control } = createGate();
		const cancellation = deferred();
		control.beginAbort(cancellation.promise);

		let refusal: unknown;
		try {
			gate.admit(() => undefined);
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(AbortRequested);
		expect((refusal as AbortRequested).cancellation).toBe(cancellation.promise);
		expect(gate.signal.aborted).toBe(false);
		cancellation.resolve();
		await cancellation.promise;
		control.signalAbort();
		expect(gate.signal.aborted).toBe(true);
	});

	it("permanently closes and signals admitted work", () => {
		const { gate, control } = createGate();
		const error = new Error("closed");
		control.close(error);
		expect(() => gate.admit(() => undefined)).toThrow(error);
		expect(gate.signal.aborted).toBe(true);
	});
});

describe("HookRegistry", () => {
	it("aggregates before_run messages in registration order with each handler seeing prior output", async () => {
		const errors: Error[] = [];
		const hooks = new HookRegistry((error) => {
			errors.push(error);
		});
		const second = vi.fn((event: { prompt: Array<{ role: string }> }) => {
			expect(event.prompt).toHaveLength(2);
			return { messages: [{ role: "user" as const, content: "second", timestamp: 3 }] };
		});
		hooks.on("before_run", () => ({ messages: [{ role: "user", content: "first", timestamp: 2 }] }));
		hooks.on("before_run", second);

		const result = await hooks.runWithGate(
			"before_run",
			{
				lane: "main",
				runId: "run",
				prompt: [{ role: "user", content: "prompt", timestamp: 1 }],
				resources: {},
			},
			createGate().gate,
			BACKGROUND_CONTEXT,
		);

		expect(result).toMatchObject({
			messages: [
				{ role: "user", content: "first" },
				{ role: "user", content: "second" },
			],
		});
		expect(second).toHaveBeenCalledOnce();
		expect(errors).toEqual([]);
	});

	it("checks the effect gate immediately before the complete before_run pipeline", async () => {
		const hooks = new HookRegistry(() => {});
		const calls: string[] = [];
		const release = deferred();
		hooks.on("before_run", async () => {
			calls.push("first:start");
			await release.promise;
			calls.push("first:end");
			return undefined;
		});
		hooks.on("before_run", () => {
			calls.push("second");
			return undefined;
		});
		const event = { lane: "main", runId: "run", prompt: [], resources: {} };
		const closed = new Error("closed");
		const closedGate = createGate();
		closedGate.control.close(closed);
		expect(() => hooks.runWithGate("before_run", event, closedGate.gate, BACKGROUND_CONTEXT)).toThrow(closed);
		expect(calls).toEqual([]);

		const running = hooks.runWithGate("before_run", event, createGate().gate, BACKGROUND_CONTEXT);
		expect(calls).toEqual(["first:start"]);
		hooks.on("before_run", () => {
			calls.push("late");
			return undefined;
		});
		hooks.close(closed);
		release.resolve();
		await running;
		expect(calls).toEqual(["first:start", "first:end", "second"]);
	});

	it("rejects pre-aborted invocations and combines admitted hook cancellation with the effect gate", async () => {
		const event = { operation: "run" as const, lane: "main", runId: "run" };
		const preAbortedHooks = new HookRegistry(() => {});
		const handler = vi.fn();
		preAbortedHooks.on("before_drive", handler);
		const preAbortedGate = createGate();
		const invocationController = new AbortController();
		const abortReason = new Error("invocation aborted");
		invocationController.abort(abortReason);

		expect(() =>
			preAbortedHooks.runWithGate(
				"before_drive",
				event,
				preAbortedGate.gate,
				withAbortSignal(invocationController.signal, BACKGROUND_CONTEXT),
			),
		).toThrow(abortReason);
		expect(handler).not.toHaveBeenCalled();
		expect(() => preAbortedGate.gate.admit(() => undefined)).not.toThrow();

		const admittedHooks = new HookRegistry(() => {});
		const admittedGate = createGate();
		let admittedSignal: AbortSignal | undefined;
		admittedHooks.on("before_drive", (_event, context) => {
			admittedSignal = context.abortSignal;
		});
		await admittedHooks.runWithGate("before_drive", event, admittedGate.gate, BACKGROUND_CONTEXT);
		expect(admittedSignal?.aborted).toBe(false);

		const gateReason = new Error("gate closed");
		admittedGate.control.close(gateReason);
		expect(admittedSignal?.aborted).toBe(true);
		expect(admittedSignal?.reason).toBe(gateReason);
	});

	it("passes tool handlers a child context of the active hook span", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const valueKey = createContextKey<string>("hook.test.value");
		const hooks = new HookRegistry(() => {});
		let receivedValue: string | undefined;
		hooks.on("before_tool", async (_event, context) => {
			receivedValue = context.value(valueKey);
			await getTelemetryContext(context).startSpan({ name: "handler.child" }, () => undefined);
			return undefined;
		});

		await telemetry.startSpan({ name: "invocation" }, (invocationSpan) =>
			hooks.runToolWithGate(
				"before_tool",
				{
					lane: "main",
					runId: "run",
					toolCallId: "call",
					toolName: "tool",
					args: {},
				},
				createGate().gate,
				withContextValue(valueKey, "preserved", withTelemetryContext(invocationSpan, BACKGROUND_CONTEXT)),
			),
		);

		expect(receivedValue).toBe("preserved");
		const spans = telemetry.getSpans();
		const invocationSpan = spans.find((span) => span.name === "invocation");
		const hookSpan = spans.find((span) => span.name === "pi.harness.hook");
		const handlerSpan = spans.find((span) => span.name === "handler.child");
		expect(hookSpan?.parentId).toBe(invocationSpan?.id);
		expect(handlerSpan?.parentId).toBe(hookSpan?.id);
	});

	it("treats registration ids as optional metadata and fails before_drive closed", async () => {
		const errors: Error[] = [];
		const hooks = new HookRegistry((error) => {
			errors.push(error);
		});
		const failure = new Error("prerequisite failed");
		const later = vi.fn();
		hooks.on(
			"before_drive",
			() => {
				throw failure;
			},
			{ id: "duplicate" },
		);
		hooks.on("before_drive", later, { id: "duplicate" });

		await expect(
			hooks.runWithGate(
				"before_drive",
				{ lane: "main", runId: "run", operation: "run" },
				createGate().gate,
				BACKGROUND_CONTEXT,
			),
		).rejects.toBe(failure);
		expect(later).not.toHaveBeenCalled();
		expect(errors).toEqual([failure]);
	});

	it("chains transform_context output and isolates handler failures", async () => {
		const errors: Error[] = [];
		const hooks = new HookRegistry((error) => {
			errors.push(error);
		});
		const messages = [{ role: "user" as const, content: "transformed", timestamp: 2 }];
		hooks.on("transform_context", () => ({ messages, systemPrompt: "first" }));
		hooks.on("transform_context", (event) => {
			expect(event.messages).toBe(messages);
			expect(event.systemPrompt).toBe("first");
			throw new Error("ignored transform failure");
		});
		hooks.on("transform_context", (event) => {
			expect(event.messages).toBe(messages);
			expect(event.systemPrompt).toBe("first");
			return { systemPrompt: "final" };
		});

		const result = await hooks.runWithGate(
			"transform_context",
			{
				lane: "main",
				runId: "run",
				messages: [{ role: "user", content: "original", timestamp: 1 }],
				systemPrompt: "base",
			},
			createGate().gate,
			BACKGROUND_CONTEXT,
		);

		expect(result).toEqual({ messages, systemPrompt: "final" });
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("ignored transform failure");
	});

	it("preserves clear-all before_request patches across later handlers", async () => {
		const hooks = new HookRegistry(() => {});
		hooks.on("before_request", () => ({ streamOptions: { headers: undefined, metadata: undefined } }));
		hooks.on("before_request", (event) => {
			expect(event.streamOptions.headers).toBeUndefined();
			expect(event.streamOptions.metadata).toBeUndefined();
			return { streamOptions: { headers: { c: "3" }, metadata: { y: 2 } } };
		});
		const result = await hooks.runWithGate(
			"before_request",
			{
				lane: "main",
				runId: "run",
				model: fauxProvider().getModel(),
				step: "assistant",
				attempt: 1,
				streamOptions: { headers: { a: "1", b: "2" }, metadata: { x: 1 } },
			},
			createGate().gate,
			BACKGROUND_CONTEXT,
		);
		expect(result).toEqual({
			streamOptions: {
				headers: { a: undefined, b: undefined, c: "3" },
				metadata: { x: undefined, y: 2 },
			},
		});
	});

	it("preserves earlier after_tool fields when a later patch returns undefined", async () => {
		const hooks = new HookRegistry(() => {});
		hooks.on("after_tool", () => ({ content: [{ type: "text", text: "patched" }] }));
		hooks.on("after_tool", () => ({ content: undefined, isError: false }));
		const result = await hooks.runWithGate(
			"after_tool",
			{
				lane: "main",
				runId: "run",
				toolCallId: "call",
				toolName: "tool",
				args: {},
				content: [{ type: "text", text: "raw" }],
				isError: true,
			},
			createGate().gate,
			BACKGROUND_CONTEXT,
		);
		expect(result).toEqual({ content: [{ type: "text", text: "patched" }], isError: false });
	});

	it("accepts explicit false structural declines and rejects true conflicts", async () => {
		const errors: Error[] = [];
		const hooks = new HookRegistry((error) => {
			errors.push(error);
		});
		const ignored = { summary: "ignored", readFiles: [], modifiedFiles: [] };
		const selected = { summary: "selected", readFiles: [], modifiedFiles: [] };
		hooks.on("before_navigation", () => ({ decline: true, summary: ignored }));
		hooks.on("before_navigation", () => ({ decline: false, summary: selected }));

		const result = await hooks.runWithGate(
			"before_navigation",
			{
				lane: "main",
				runId: "run",
				targetId: "target",
				preparation: {
					messages: [],
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
					totalTokens: 0,
				},
			},
			createGate().gate,
			BACKGROUND_CONTEXT,
		);
		expect(result).toEqual({ decline: false, summary: selected });
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toMatch(/cannot return both decline and summary/);
	});

	it("admits the complete before_drive pipeline as one gated effect", async () => {
		const hooks = new HookRegistry(() => {});
		const calls: string[] = [];
		const release = deferred();
		hooks.on("before_drive", async () => {
			calls.push("first:start");
			await release.promise;
			calls.push("first:end");
		});
		hooks.on("before_drive", () => {
			calls.push("second");
		});
		const event = { operation: "run" as const, lane: "main", runId: "run" };

		const abortFirstGate = createGate();
		const cancellation = Promise.resolve();
		abortFirstGate.control.beginAbort(cancellation);
		expect(() => hooks.runWithGate("before_drive", event, abortFirstGate.gate, BACKGROUND_CONTEXT)).toThrow(
			AbortRequested,
		);
		expect(calls).toEqual([]);

		const startFirstGate = createGate();
		const running = hooks.runWithGate("before_drive", event, startFirstGate.gate, BACKGROUND_CONTEXT);
		expect(calls).toEqual(["first:start"]);
		startFirstGate.control.beginAbort(cancellation);
		startFirstGate.control.signalAbort();
		release.resolve();
		await running;
		expect(calls).toEqual(["first:start", "first:end", "second"]);
	});
});

describe("HarnessEventBus", () => {
	it("buffers between snapshot and start, then delivers each event once in order", async () => {
		const bus = new HarnessEventBus();
		const watcher = bus.watch({ tipId: null }, () => true, BACKGROUND_CONTEXT);
		await bus.emit({ type: "run_start", runId: "one", startedAt: 1, lane: "main" }, BACKGROUND_CONTEXT);
		const seen: string[] = [];
		watcher.start((event) => {
			seen.push(`${event.type}:${"runId" in event ? event.runId : ""}`);
		});
		await bus.emit({ type: "run_start", runId: "two", startedAt: 1, lane: "main" }, BACKGROUND_CONTEXT);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(watcher.snapshot).toEqual({ tipId: null });
		expect(seen).toEqual(["run_start:one", "run_start:two"]);
		watcher.unsubscribe();
		await bus.emit({ type: "run_start", runId: "three", startedAt: 1, lane: "main" }, BACKGROUND_CONTEXT);
		expect(seen).toHaveLength(2);
	});

	it("drops pre-snapshot delivery and holds later events when resnapshotting inside a listener", async () => {
		const bus = new HarnessEventBus();
		const listenerStarted = deferred();
		const releaseListener = deferred();
		const resnapshotDone = deferred();
		const watcher = bus.watch(
			{ version: "old" },
			() => true,
			BACKGROUND_CONTEXT,
			async (_context, markBoundary) => {
				markBoundary();
				return { version: "fresh" };
			},
		);
		const queueEvents: string[] = [];
		watcher.start(async (event, context) => {
			if (event.type === "run_start" && event.runId === "blocking") {
				listenerStarted.resolve();
				await releaseListener.promise;
			} else if (event.type === "navigation_end") {
				await watcher.resnapshot(context);
				resnapshotDone.resolve();
			} else if (event.type === "queue_update") {
				queueEvents.push(event.queues[0]?.entryId ?? "empty");
			}
		});
		await bus.emit({ type: "run_start", runId: "blocking", startedAt: 1, lane: "main" }, BACKGROUND_CONTEXT);
		await listenerStarted.promise;
		const queued = bus.emitBatch(
			[
				{
					type: "navigation_end",
					runId: "navigation",
					status: "completed",
					fromTipId: null,
					tipId: null,
					endedAt: 2,
					lane: "main",
				},
				{
					type: "queue_update",
					queues: [
						{
							entryId: "stale",
							kind: "nextRun",
							type: "message",
							message: { role: "user", content: "stale", timestamp: 2 },
						},
					],
					lane: "main",
				},
			],
			BACKGROUND_CONTEXT,
		);
		releaseListener.resolve();
		await Promise.all([queued, resnapshotDone.promise]);

		expect(watcher.snapshot).toEqual({ version: "fresh" });
		expect(queueEvents).toEqual([]);
		await bus.emit(
			{
				type: "queue_update",
				queues: [
					{
						entryId: "later",
						kind: "nextRun",
						type: "message",
						message: { role: "user", content: "later", timestamp: 3 },
					},
				],
				lane: "main",
			},
			BACKGROUND_CONTEXT,
		);
		await expect.poll(() => queueEvents).toEqual(["later"]);
	});

	it("isolates each listener from payload mutation", async () => {
		const bus = new HarnessEventBus();
		let observed: string[] = [];
		bus.on("config_update", (event) => {
			if (event.property === "activeTools") event.value.push("mutated");
		});
		bus.on("config_update", (event) => {
			if (event.property === "activeTools") observed = event.value;
		});
		await bus.emit(
			{
				type: "config_update",
				property: "activeTools",
				value: ["read"],
				previous: [],
				lane: "main",
			},
			BACKGROUND_CONTEXT,
		);
		expect(observed).toEqual(["read"]);
	});

	it("serializes concurrent publications in process order", async () => {
		const bus = new HarnessEventBus();
		const started = deferred();
		const release = deferred();
		const seen: string[] = [];
		bus.on("run_start", async (event) => {
			seen.push(`${event.runId}:start`);
			if (event.runId === "one") {
				started.resolve();
				await release.promise;
			}
			seen.push(`${event.runId}:end`);
		});

		const one = bus.emit({ type: "run_start", runId: "one", startedAt: 1, lane: "main" }, BACKGROUND_CONTEXT);
		await started.promise;
		const two = bus.emit({ type: "run_start", runId: "two", startedAt: 1, lane: "main" }, BACKGROUND_CONTEXT);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(seen).toEqual(["one:start"]);
		release.resolve();
		await Promise.all([one, two]);
		expect(seen).toEqual(["one:start", "one:end", "two:start", "two:end"]);
	});

	it("keeps concurrent batches contiguous with their emitting contexts", async () => {
		const bus = new HarnessEventBus();
		const sourceKey = createContextKey<string>("event.batch.source");
		const firstContext = withContextValue(sourceKey, "first", BACKGROUND_CONTEXT);
		const secondContext = withContextValue(sourceKey, "second", BACKGROUND_CONTEXT);
		const seen: Array<{ runId: string; context: typeof firstContext }> = [];
		bus.on("run_start", async (event, context) => {
			seen.push({ runId: event.runId, context });
			await Promise.resolve();
		});

		const first = bus.emitBatch(
			[
				{ type: "run_start", runId: "a1", startedAt: 1, lane: "main" },
				{ type: "run_start", runId: "a2", startedAt: 1, lane: "main" },
			],
			firstContext,
		);
		const second = bus.emitBatch(
			[
				{ type: "run_start", runId: "b1", startedAt: 1, lane: "worker" },
				{ type: "run_start", runId: "b2", startedAt: 1, lane: "worker" },
			],
			secondContext,
		);

		await Promise.all([first, second]);
		expect(seen.map(({ runId }) => runId)).toEqual(["a1", "a2", "b1", "b2"]);
		expect(seen.slice(0, 2).every(({ context }) => context === firstContext)).toBe(true);
		expect(seen.slice(2).every(({ context }) => context === secondContext)).toBe(true);
	});

	it("binds listeners and watchers when a batch is emitted", async () => {
		const bus = new HarnessEventBus();
		const started = deferred();
		const release = deferred();
		bus.on("run_start", async (event) => {
			if (event.runId !== "blocking") return;
			started.resolve();
			await release.promise;
		});
		const blocking = bus.emit(
			{ type: "run_start", runId: "blocking", startedAt: 1, lane: "main" },
			BACKGROUND_CONTEXT,
		);
		await started.promise;

		const queued = bus.emit({ type: "run_start", runId: "queued", startedAt: 1, lane: "main" }, BACKGROUND_CONTEXT);
		const lateListenerEvents: string[] = [];
		bus.on("run_start", (event) => {
			lateListenerEvents.push(event.runId);
		});
		const lateWatcherEvents: string[] = [];
		const lateWatcher = bus.watch({}, (event) => event.type === "run_start", BACKGROUND_CONTEXT);
		lateWatcher.start((event) => {
			if (event.type === "run_start") lateWatcherEvents.push(event.runId);
		});

		release.resolve();
		await Promise.all([blocking, queued]);
		expect(lateListenerEvents).toEqual([]);
		expect(lateWatcherEvents).toEqual([]);

		await bus.emit({ type: "run_start", runId: "later", startedAt: 1, lane: "main" }, BACKGROUND_CONTEXT);
		expect(lateListenerEvents).toEqual(["later"]);
		expect(lateWatcherEvents).toEqual(["later"]);
	});

	it("resolves an empty batch without delivery", async () => {
		const bus = new HarnessEventBus();
		const listener = vi.fn();
		bus.on("run_start", listener);

		await bus.emitBatch([], BACKGROUND_CONTEXT);

		expect(listener).not.toHaveBeenCalled();
	});

	it("drains already emitted contiguous batches during close and ignores later publication", async () => {
		const bus = new HarnessEventBus();
		const started = deferred();
		const release = deferred();
		const seen: string[] = [];
		bus.on("run_start", async (event) => {
			seen.push(event.runId);
			if (event.runId === "blocking") {
				started.resolve();
				await release.promise;
			}
		});
		const blocking = bus.emit(
			{ type: "run_start", runId: "blocking", startedAt: 1, lane: "main" },
			BACKGROUND_CONTEXT,
		);
		await started.promise;
		const batch = bus.emitBatch(
			[
				{ type: "run_start", runId: "one", startedAt: 1, lane: "main" },
				{ type: "run_start", runId: "two", startedAt: 1, lane: "main" },
			],
			BACKGROUND_CONTEXT,
		);

		bus.close(new Error("closed"));
		await bus.emit({ type: "run_start", runId: "late", startedAt: 1, lane: "main" }, BACKGROUND_CONTEXT);
		release.resolve();
		await Promise.all([blocking, batch]);

		expect(seen).toEqual(["blocking", "one", "two"]);
	});

	it("continues watcher delivery after listener failure and reports it", async () => {
		const bus = new HarnessEventBus();
		const failures: string[] = [];
		bus.on("handler_error", (event) => {
			failures.push(event.error);
		});
		const watcher = bus.watch({}, (event) => event.type === "run_start", BACKGROUND_CONTEXT);
		const seen: string[] = [];
		watcher.start((event) => {
			if (event.type !== "run_start") return;
			if (event.runId === "one") throw new Error("watcher failed");
			seen.push(event.runId);
		});

		await bus.emit({ type: "run_start", runId: "one", startedAt: 1, lane: "main" }, BACKGROUND_CONTEXT);
		await bus.emit({ type: "run_start", runId: "two", startedAt: 1, lane: "main" }, BACKGROUND_CONTEXT);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(seen).toEqual(["two"]);
		expect(failures).toEqual(["watcher failed"]);
	});

	it("isolates listener failures and emits handler_error", async () => {
		const bus = new HarnessEventBus();
		const failures: string[] = [];
		bus.on("run_start", () => {
			throw new Error("listener failed");
		});
		bus.on("handler_error", (event) => {
			failures.push(event.error);
		});
		await bus.emit({ type: "run_start", runId: "run", startedAt: 1, lane: "main" }, BACKGROUND_CONTEXT);
		expect(failures).toEqual(["listener failed"]);
	});

	it("does not recurse when a handler_error listener fails", async () => {
		const bus = new HarnessEventBus();
		let handlerErrors = 0;
		bus.on("run_start", () => {
			throw new Error("listener failed");
		});
		bus.on("handler_error", () => {
			handlerErrors += 1;
			throw new Error("error listener failed");
		});

		await bus.emit({ type: "run_start", runId: "run", startedAt: 1, lane: "main" }, BACKGROUND_CONTEXT);

		expect(handlerErrors).toBe(1);
	});
});
