import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentHarness,
	type AgentLane,
	HarnessClosed,
	HarnessFault,
	type OperationAdmission,
	type Resources,
} from "../../../src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT, withCancel } from "../../../src/harness/context.ts";
import { Lane } from "../../../src/harness/runtime/lane.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type { Session } from "../../../src/harness/session/types.ts";
import { deferred } from "./test-utils.ts";

const sessions: Session[] = [];

async function createFixture(options: { deferred?: boolean; resources?: Resources } = {}): Promise<{
	lane: AgentLane;
	runtimeLane: Lane<object | undefined>;
	harness: Awaited<ReturnType<typeof AgentHarness.create>>["harness"];
	faux: ReturnType<typeof fauxProvider>;
	session: Session;
}> {
	const session = new StorageBackedSession(
		{ id: `public-drive-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		new MemoryStorage(),
	);
	sessions.push(session);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create(
		{
			session,
			models,
			model: faux.getModel(),
			...(options.deferred === true ? { streamOptions: { deferred: true } } : {}),
			...(options.resources === undefined ? {} : { resources: options.resources }),
		},
		BACKGROUND_CONTEXT,
	);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	if (!(lane instanceof Lane)) throw new Error("Expected runtime Lane");
	return { lane, runtimeLane: lane, harness, faux, session };
}

async function acceptRun(lane: AgentLane, operationId: string): Promise<OperationAdmission> {
	const result = await lane.accept({ kind: "prompt", operationId, prompt: operationId }, BACKGROUND_CONTEXT);
	if (!result.ok) throw result.error;
	return result.value;
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime public drive", () => {
	it("persists model identity without requiring a local registration", async () => {
		const { lane, faux } = await createFixture();
		await lane.setModel({ provider: "missing", modelId: "missing-model" }, BACKGROUND_CONTEXT);

		expect(await lane.getModel(BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await lane.prompt("prompt", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: {
				kind: "run",
				status: "failed",
				error: { code: "model_unavailable" },
			},
		});
		expect(faux.state.callCount).toBe(0);
	});

	it("composes prompt, skill, and template acceptance with drive", async () => {
		const resources: Resources = {
			skills: [
				{ name: "review", description: "Review", content: "Inspect it", filePath: "/skills/review/SKILL.md" },
			],
			promptTemplates: [{ name: "fix", content: "Fix $1" }],
		};
		const { lane, faux } = await createFixture({ resources });
		faux.setResponses([
			fauxAssistantMessage("prompt answer"),
			fauxAssistantMessage("skill answer"),
			fauxAssistantMessage("template answer"),
		]);

		expect(await lane.prompt("prompt", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "run", status: "completed" },
		});
		expect(await lane.skill("review", "strict", BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "run", status: "completed" },
		});
		expect(await lane.promptFromTemplate("fix", ["it"], BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "run", status: "completed" },
		});
		expect(faux.state.callCount).toBe(3);
	});

	it("returns a convenience-only suspension observation", async () => {
		const { lane, runtimeLane, faux } = await createFixture({ deferred: true });
		faux.setResponses([fauxAssistantMessage("eventual answer")]);

		expect(await lane.prompt("defer", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: {
				operationId: expect.any(String),
				status: "suspended",
				deferred: { provider: "faux", modelId: "faux-1" },
			},
		});
		expect(runtimeLane.state.operation?.state.at).toBe("deferred.suspended");
	});

	it("records caller usage as an adjustment and publishes committed totals", async () => {
		const { lane, harness, session } = await createFixture();
		const usage = fauxAssistantMessage("usage").usage;
		const events: unknown[] = [];
		harness.events.on("usage", (event) => {
			events.push(event);
		});

		const recorded = await lane.recordUsage(
			usage,
			{ entryId: "external", details: { source: "test" } },
			BACKGROUND_CONTEXT,
		);
		if (!recorded.ok) throw recorded.error;

		expect(events).toEqual([
			expect.objectContaining({
				type: "usage",
				lane: "main",
				row: expect.objectContaining({ id: recorded.value.usageId, adjustment: true }),
				totals: (await session.getStats(BACKGROUND_CONTEXT)).usage,
			}),
		]);
	});

	it.each(["steer", "followUp", "nextRun"] as const)(
		"starts an ordinary continuation run from queued %s input",
		async (kind) => {
			const { lane, faux } = await createFixture();
			await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
			const summaryStarted = deferred();
			const releaseSummary = deferred();
			faux.setResponses([
				async () => {
					summaryStarted.resolve();
					await releaseSummary.promise;
					return fauxAssistantMessage("summary");
				},
				fauxAssistantMessage("continuation answer"),
			]);
			const compacting = lane.compact(undefined, BACKGROUND_CONTEXT);
			await summaryStarted.promise;
			const queued = await lane[kind]("continue", undefined, BACKGROUND_CONTEXT);
			expect(queued.ok).toBe(true);
			releaseSummary.resolve();

			expect(await compacting).toMatchObject({
				ok: true,
				value: {
					compaction: { kind: "compaction", status: "completed" },
					run: { kind: "run", status: "completed" },
				},
			});
			expect(faux.state.callCount).toBe(2);
		},
	);

	it("lets a competing acceptance win the structural continuation window", async () => {
		const { lane, harness, faux } = await createFixture();
		await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
		const summaryStarted = deferred();
		const releaseSummary = deferred();
		faux.setResponses([
			async () => {
				summaryStarted.resolve();
				await releaseSummary.promise;
				return fauxAssistantMessage("summary");
			},
			fauxAssistantMessage("competitor answer"),
		]);
		let competing: ReturnType<typeof lane.accept> | undefined;
		harness.events.on("compaction_end", (event) => {
			if (event.status === "completed") {
				competing = lane.accept({ kind: "prompt", prompt: "competitor" }, BACKGROUND_CONTEXT);
			}
		});
		const compacting = lane.compact(undefined, BACKGROUND_CONTEXT);
		await summaryStarted.promise;
		await lane.nextRun("queued", undefined, BACKGROUND_CONTEXT);
		releaseSummary.resolve();

		const compacted = await compacting;
		expect(compacted).toMatchObject({ ok: true, value: { compaction: { status: "completed" } } });
		if (!compacted.ok) throw compacted.error;
		expect(compacted.value).not.toHaveProperty("run");
		if (competing === undefined) throw new Error("Competing acceptance did not start");
		const admission = await competing;
		if (!admission.ok) throw admission.error;
		expect(await lane.drive({ operationId: admission.value.operationId }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { status: "completed" } },
		});
	});

	it("cancels queued input and reports consumed or missing ids", async () => {
		const { lane, faux } = await createFixture();
		const cancelled = await lane.nextRun("cancel", undefined, BACKGROUND_CONTEXT);
		if (!cancelled.ok) throw cancelled.error;
		expect(await lane.cancelQueued(cancelled.value.entryId, BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: { kind: "cancelled" },
		});
		expect(await lane.cancelQueued(cancelled.value.entryId, BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: { kind: "not_found" },
		});

		const consumed = await lane.nextRun("consume", undefined, BACKGROUND_CONTEXT);
		if (!consumed.ok) throw consumed.error;
		const admission = await lane.accept({ kind: "prompt", prompt: "" }, BACKGROUND_CONTEXT);
		if (!admission.ok) throw admission.error;
		expect(await lane.cancelQueued(consumed.value.entryId, BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: { kind: "already_consumed" },
		});
		faux.setResponses([fauxAssistantMessage("answer")]);
		await lane.drive({ operationId: admission.value.operationId }, BACKGROUND_CONTEXT);
	});

	it("admits input after cancellation and preserves it through reconciliation", async () => {
		const { lane, runtimeLane, faux } = await createFixture();
		await acceptRun(lane, "cancelled");
		await lane.requestAbort("cancelled", BACKGROUND_CONTEXT);
		const late = await lane.steer("late", undefined, BACKGROUND_CONTEXT);
		expect(late.ok).toBe(true);
		expect(await lane.drive({ operationId: "cancelled" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { status: "aborted" } },
		});
		expect(runtimeLane.state.inbox).toHaveLength(1);

		faux.setResponses([fauxAssistantMessage("late answer")]);
		expect(await lane.prompt("", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "run", status: "completed" },
		});
	});

	it("composes standalone compaction acceptance with drive", async () => {
		const { lane, faux } = await createFixture();
		await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
		faux.setResponses([fauxAssistantMessage("summary")]);

		expect(await lane.compact(undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { compaction: { kind: "compaction", status: "completed" } },
		});
		expect(faux.state.callCount).toBe(1);
	});

	it.each([false, true])("composes %s summarized navigation acceptance with drive", async (summarize) => {
		const { lane, session, faux } = await createFixture();
		const rootId = await lane.appendMessage({ role: "user", content: "root", timestamp: 1 }, BACKGROUND_CONTEXT);
		await lane.appendMessage({ role: "user", content: "source", timestamp: 2 }, BACKGROUND_CONTEXT);
		await session.mutate(
			(mutator) =>
				mutator.commit(
					[
						{
							kind: "entry",
							entry: {
								id: "target",
								parentId: rootId,
								type: "message",
								message: { role: "user", content: "target", timestamp: 3 },
							},
						},
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);
		if (summarize) faux.setResponses([fauxAssistantMessage("branch summary")]);

		expect(await lane.navigateTree("target", { summarize, label: "chosen" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { navigation: { kind: "navigation", status: "completed" } },
		});
		expect(faux.state.callCount).toBe(summarize ? 1 : 0);
		expect(await lane.getTipId(BACKGROUND_CONTEXT)).not.toBeNull();
	});

	it("resumes any current operation after acceptance or reopen", async () => {
		const { lane, faux } = await createFixture();
		await acceptRun(lane, "run");
		faux.setResponses([fauxAssistantMessage("answer")]);

		expect(await lane.resume(BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { operationId: "run", kind: "run", status: "completed" },
		});
	});

	it("polls one deferred permit through resume", async () => {
		const { lane, runtimeLane, faux } = await createFixture({ deferred: true });
		faux.setResponses([fauxAssistantMessage("eventual answer")]);
		const suspended = await lane.prompt("defer", undefined, BACKGROUND_CONTEXT);
		if (!suspended.ok || suspended.value.status !== "suspended") throw new Error("Expected suspended run");

		expect(await lane.resume(BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { operationId: suspended.value.operationId, kind: "run", status: "completed" },
		});
		expect(runtimeLane.state.operation).toBeNull();
		expect(faux.state.deferredFetchCount).toBe(1);
		expect(await lane.resume(BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "NothingToResume" },
		});
	});

	it("aborts and reconciles the current operation", async () => {
		const { lane, runtimeLane, faux } = await createFixture();
		await acceptRun(lane, "run");

		expect(await lane.abort(BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			value: { operationId: "run", steer: [], followUp: [] },
		});
		expect(runtimeLane.state.operation).toBeNull();
		expect(faux.state.callCount).toBe(0);
		expect(await lane.abort(BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "NoActiveOperation" },
		});
	});

	it("waits for an operation that has no installed drive", async () => {
		const { lane, faux } = await createFixture();
		await acceptRun(lane, "run");
		let idle = false;
		const waiting = lane.waitForIdle(BACKGROUND_CONTEXT).then(() => {
			idle = true;
		});
		await Promise.resolve();
		expect(idle).toBe(false);

		faux.setResponses([fauxAssistantMessage("answer")]);
		await lane.drive({ operationId: "run" }, BACKGROUND_CONTEXT);
		await waiting;
		expect(idle).toBe(true);
	});

	it("serializes concurrent runWhenIdle callbacks", async () => {
		const { lane } = await createFixture();
		const firstStarted = deferred();
		const releaseFirst = deferred();
		const order: string[] = [];
		const first = lane.runWhenIdle(async () => {
			order.push("first:start");
			firstStarted.resolve();
			await releaseFirst.promise;
			order.push("first:end");
		}, BACKGROUND_CONTEXT);
		await firstStarted.promise;
		const second = lane.runWhenIdle(() => {
			order.push("second");
		}, BACKGROUND_CONTEXT);
		await Promise.resolve();
		expect(order).toEqual(["first:start"]);

		releaseFirst.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("owns the idle window while runWhenIdle executes", async () => {
		const { lane, faux } = await createFixture();
		const callbackStarted = deferred();
		const releaseCallback = deferred();
		const callback = lane.runWhenIdle(async () => {
			callbackStarted.resolve();
			await releaseCallback.promise;
		}, BACKGROUND_CONTEXT);
		await callbackStarted.promise;
		let accepted = false;
		const acceptance = lane.accept({ kind: "prompt", prompt: "after" }, BACKGROUND_CONTEXT).then((result) => {
			accepted = true;
			return result;
		});
		await Promise.resolve();
		expect(accepted).toBe(false);

		releaseCallback.resolve();
		await callback;
		const admission = await acceptance;
		if (!admission.ok) throw admission.error;
		faux.setResponses([fauxAssistantMessage("answer")]);
		await lane.drive({ operationId: admission.value.operationId }, BACKGROUND_CONTEXT);
	});

	it("allows coherent lane reads from an idle callback", async () => {
		const { lane } = await createFixture();

		await lane.runWhenIdle(async (context) => {
			const execution = await lane.inspectExecution(context);
			const watch = await lane.watch(context);
			expect(execution.current).toBeNull();
			expect(watch.snapshot.operation).toBeNull();
			watch.unsubscribe();
		}, BACKGROUND_CONTEXT);
	});

	it("releases idle ownership when the callback fails", async () => {
		const { lane } = await createFixture();
		const failure = new Error("callback failed");

		await expect(
			lane.runWhenIdle(() => {
				throw failure;
			}, BACKGROUND_CONTEXT),
		).rejects.toBe(failure);
		expect(await lane.accept({ kind: "prompt", prompt: "after" }, BACKGROUND_CONTEXT)).toMatchObject({ ok: true });
	});

	it("close waits for an already-running idle callback", async () => {
		const { lane, harness } = await createFixture();
		const callbackStarted = deferred();
		const releaseCallback = deferred();
		const callback = lane.runWhenIdle(async () => {
			callbackStarted.resolve();
			await releaseCallback.promise;
		}, BACKGROUND_CONTEXT);
		await callbackStarted.promise;
		let closed = false;
		const closing = harness.close(BACKGROUND_CONTEXT).then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);

		releaseCallback.resolve();
		await Promise.all([callback, closing]);
		expect(closed).toBe(true);
	});

	it("installs one pass and joins same-operation callers", async () => {
		const { lane, runtimeLane, faux } = await createFixture();
		const started = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("answer");
			},
		]);
		const admission = await acceptRun(lane, "run");

		const first = lane.drive({ operationId: admission.operationId }, BACKGROUND_CONTEXT);
		await started.promise;
		const second = lane.drive({ operationId: admission.operationId }, BACKGROUND_CONTEXT);
		expect(runtimeLane.activeDrive?.operationId).toBe(admission.operationId);
		release.resolve();

		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { operationId: "run", status: "completed" } },
		});
		expect(secondResult).toEqual(firstResult);
		expect(faux.state.callCount).toBe(1);
		expect(runtimeLane.activeDrive).toBeUndefined();
	});

	it("returns old result records without disturbing the current operation", async () => {
		const { lane, runtimeLane, faux } = await createFixture();
		faux.setResponses([fauxAssistantMessage("first")]);
		await acceptRun(lane, "first");
		expect(await lane.drive({ operationId: "first" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { operationId: "first" } },
		});
		await acceptRun(lane, "second");

		expect(await lane.drive({ operationId: "first" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { operationId: "first" } },
		});
		expect(runtimeLane.state.operation?.meta.operationId).toBe("second");
		expect(runtimeLane.activeDrive).toBeUndefined();

		faux.setResponses([fauxAssistantMessage("second")]);
		expect(await lane.drive({ operationId: "second" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { operationId: "second" } },
		});
	});

	it("isolates stale operation ids", async () => {
		const { lane, runtimeLane, faux } = await createFixture();
		await acceptRun(lane, "current");

		expect(await lane.drive({ operationId: "stale" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "OperationMismatch", expectedOperationId: "stale", currentOperationId: "current" },
		});
		expect(runtimeLane.activeDrive).toBeUndefined();
		expect(faux.state.callCount).toBe(0);
	});

	it("does not install for a caller already cancelled", async () => {
		const { lane, runtimeLane, faux } = await createFixture();
		await acceptRun(lane, "run");
		const caller = withCancel(BACKGROUND_CONTEXT);
		const cancelled = new Error("caller cancelled");
		caller.cancel(cancelled);

		await expect(lane.drive({ operationId: "run" }, caller.context)).rejects.toBe(cancelled);
		expect(runtimeLane.activeDrive).toBeUndefined();
		expect(faux.state.callCount).toBe(0);
	});

	it("caller cancellation stops only that caller's observation", async () => {
		const { lane, runtimeLane, faux } = await createFixture();
		const started = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("answer");
			},
		]);
		await acceptRun(lane, "run");
		const owner = lane.drive({ operationId: "run" }, BACKGROUND_CONTEXT);
		await started.promise;
		const caller = withCancel(BACKGROUND_CONTEXT);
		const observer = lane.drive({ operationId: "run" }, caller.context);
		const cancelled = new Error("observer cancelled");
		caller.cancel(cancelled);

		await expect(observer).rejects.toBe(cancelled);
		expect(runtimeLane.activeDrive?.operationId).toBe("run");
		release.resolve();
		expect(await owner).toMatchObject({ ok: true, value: { kind: "settled" } });
		expect(faux.state.callCount).toBe(1);
	});

	it("close rejects observation without waiting for a non-cooperative effect", async () => {
		const { lane, runtimeLane, harness, faux } = await createFixture();
		const started = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("late");
			},
		]);
		await acceptRun(lane, "run");
		const observation = lane.drive({ operationId: "run" }, BACKGROUND_CONTEXT);
		await started.promise;

		await harness.close(BACKGROUND_CONTEXT);
		await expect(observation).rejects.toBeInstanceOf(HarnessClosed);
		release.resolve();
		await expect.poll(() => runtimeLane.activeDrive).toBeUndefined();
	});

	it("exposes durable abort and reconciles through public drive", async () => {
		const { lane, runtimeLane, faux } = await createFixture();
		await acceptRun(lane, "run");

		expect(await lane.requestAbort("run", BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { operationId: "run", newlyRequested: true, steer: [], followUp: [] },
		});
		expect(runtimeLane.activeDrive).toBeUndefined();
		expect(await lane.drive({ operationId: "run" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { operationId: "run", status: "aborted" } },
		});
		expect(faux.state.callCount).toBe(0);
		expect(await lane.requestAbort("run", BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "OperationMismatch", expectedOperationId: "run", lastOperationId: "run" },
		});
	});

	it("faults the harness when a detached pass fails", async () => {
		const { lane, runtimeLane, harness } = await createFixture();
		harness.hooks.on("before_drive", () => {
			throw new Error("drive failed");
		});
		await acceptRun(lane, "run");

		await expect(lane.drive({ operationId: "run" }, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessFault);
		expect(runtimeLane.activeDrive).toBeUndefined();
		await expect(lane.getTipId(BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessFault);
	});
});
