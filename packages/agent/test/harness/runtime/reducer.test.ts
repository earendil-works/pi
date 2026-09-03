import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness, type HarnessEvent, type LaneSnapshot } from "../../../src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../../src/harness/context.ts";
import { reduceLaneSnapshot } from "../../../src/harness/runtime/reducer.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type { Session } from "../../../src/harness/session/types.ts";

const sessions: Session[] = [];

async function createFixture(options: { deferred?: boolean } = {}) {
	const session = new StorageBackedSession(
		{ id: `reducer-${sessions.length}`, createdAt: 1, storageVersion: 1 },
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
		},
		BACKGROUND_CONTEXT,
	);
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	return { harness, lane, faux };
}

async function settleEvents(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function fold(snapshot: LaneSnapshot, events: HarnessEvent[]): LaneSnapshot {
	for (const event of events) {
		if (reduceLaneSnapshot(snapshot, event) === "rebase") throw new Error(`Unexpected rebase for ${event.type}`);
	}
	return snapshot;
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("lane snapshot reducer", () => {
	it("folds an ordinary run to the authoritative resnapshot", async () => {
		const { lane, faux } = await createFixture();
		const watch = await lane.watch(BACKGROUND_CONTEXT);
		const events: HarnessEvent[] = [];
		watch.start((event) => {
			events.push(event);
		});
		faux.setResponses([fauxAssistantMessage("answer")]);

		expect(await lane.prompt("question", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "run", status: "completed" },
		});
		await settleEvents();

		expect(fold(watch.snapshot, events)).toEqual(await watch.resnapshot(BACKGROUND_CONTEXT));
		watch.unsubscribe();
	});

	it("folds suspend and resume without closing the operation early", async () => {
		const { lane, faux } = await createFixture({ deferred: true });
		const watch = await lane.watch(BACKGROUND_CONTEXT);
		const events: HarnessEvent[] = [];
		watch.start((event) => {
			events.push(event);
		});
		faux.setResponses([fauxAssistantMessage("answer")]);

		expect(await lane.prompt("question", undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { status: "suspended" },
		});
		await settleEvents();
		let replica = fold(watch.snapshot, events);
		expect(replica.operation).toMatchObject({ kind: "run", deferred: { poll: 0 } });
		expect(replica).toEqual(await watch.resnapshot(BACKGROUND_CONTEXT));

		events.length = 0;
		expect(await lane.resume(BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { kind: "run", status: "completed" },
		});
		await settleEvents();
		replica = fold(watch.snapshot, events);
		expect(replica).toEqual(await watch.resnapshot(BACKGROUND_CONTEXT));
		watch.unsubscribe();
	});

	it("folds standalone compaction and preserves segment semantics", async () => {
		const { lane, faux } = await createFixture();
		await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
		const watch = await lane.watch(BACKGROUND_CONTEXT);
		const events: HarnessEvent[] = [];
		watch.start((event) => {
			events.push(event);
		});
		faux.setResponses([fauxAssistantMessage("summary")]);

		expect(await lane.compact(undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: true,
			value: { compaction: { status: "completed" } },
		});
		await settleEvents();
		const replica = fold(watch.snapshot, events);

		expect(replica.operation).toBeNull();
		expect(replica.lastResult).toMatchObject({ kind: "compaction", status: "completed" });
		expect(replica).toEqual(await watch.resnapshot(BACKGROUND_CONTEXT));
		watch.unsubscribe();
	});

	it("replicates globally ordered queue changes", async () => {
		const { lane } = await createFixture();
		const watch = await lane.watch(BACKGROUND_CONTEXT);
		const events: HarnessEvent[] = [];
		watch.start((event) => {
			events.push(event);
		});

		await lane.nextRun("next", undefined, BACKGROUND_CONTEXT);
		const steer = await lane.steer("steer", undefined, BACKGROUND_CONTEXT);
		await lane.followUp("follow", undefined, BACKGROUND_CONTEXT);
		if (!steer.ok) throw steer.error;
		await lane.cancelQueued(steer.value.entryId, BACKGROUND_CONTEXT);
		await settleEvents();

		const replica = fold(watch.snapshot, events);
		expect(replica.queues.map((item) => item.kind)).toEqual(["nextRun", "followUp"]);
		expect(replica).toEqual(await watch.resnapshot(BACKGROUND_CONTEXT));
		watch.unsubscribe();
	});

	it("keeps in-run compaction segments inside the open run", async () => {
		const { lane } = await createFixture();
		const snapshot = (await lane.watch(BACKGROUND_CONTEXT)).snapshot;
		const running: LaneSnapshot = {
			...snapshot,
			operation: {
				id: "run",
				kind: "run",
				startedAt: 1,
				fromTipId: null,
				status: "open",
				runningTools: [],
			},
		};
		expect(
			reduceLaneSnapshot(running, {
				type: "compaction_start",
				lane: "main",
				runId: "run",
				reason: "threshold",
				startedAt: 2,
			}),
		).toBeUndefined();
		expect(
			reduceLaneSnapshot(running, {
				type: "compaction_end",
				lane: "main",
				runId: "run",
				reason: "threshold",
				status: "declined",
				endedAt: 3,
			}),
		).toBeUndefined();
		expect(running).toMatchObject({ operation: { id: "run", kind: "run" } });
	});

	it("retains settled parallel tools until each source-ordered result is placed", async () => {
		const { lane } = await createFixture();
		const snapshot = (await lane.watch(BACKGROUND_CONTEXT)).snapshot;
		snapshot.operation = {
			id: "run",
			kind: "run",
			startedAt: 1,
			fromTipId: null,
			status: "open",
			runningTools: [],
		};
		const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: { text } });
		const start = (index: number): HarnessEvent => ({
			type: "tool_start",
			lane: "main",
			runId: "run",
			turnId: "turn",
			toolCallId: `call-${index}`,
			toolName: `tool-${index}`,
			args: { index },
		});
		const end = (index: number): HarnessEvent => ({
			type: "tool_end",
			lane: "main",
			runId: "run",
			turnId: "turn",
			toolCallId: `call-${index}`,
			toolName: `tool-${index}`,
			result: result(`done-${index}`),
			isError: false,
			terminate: false,
		});
		const entry = (index: number): HarnessEvent => ({
			type: "entry_added",
			lane: "main",
			entry: {
				id: `result-${index}`,
				parentId: index === 0 ? null : `result-${index - 1}`,
				seq: index + 1,
				timestamp: index + 1,
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: `call-${index}`,
					toolName: `tool-${index}`,
					content: [{ type: "text", text: `done-${index}` }],
					isError: false,
					timestamp: index + 1,
				},
			},
		});

		for (let index = 0; index < 3; index += 1) reduceLaneSnapshot(snapshot, start(index));
		expect(snapshot.operation.runningTools).toHaveLength(3);
		reduceLaneSnapshot(snapshot, start(0));
		expect(snapshot.operation.runningTools).toHaveLength(3);

		reduceLaneSnapshot(snapshot, {
			type: "tool_update",
			lane: "main",
			runId: "stale",
			turnId: "turn",
			toolCallId: "call-1",
			toolName: "tool-1",
			partialResult: result("stale"),
		});
		expect(snapshot.operation.runningTools[1]).not.toHaveProperty("result");

		reduceLaneSnapshot(snapshot, end(2));
		expect(snapshot.operation.runningTools.find(({ toolCallId }) => toolCallId === "call-2")).toMatchObject({
			status: "settled",
			args: { index: 2 },
			result: result("done-2"),
		});

		reduceLaneSnapshot(snapshot, end(0));
		expect(snapshot.operation.runningTools.map(({ status }) => status)).toEqual(["settled", "running", "settled"]);
		reduceLaneSnapshot(snapshot, entry(0));
		expect(snapshot.operation.runningTools.map(({ toolCallId }) => toolCallId)).toEqual(["call-1", "call-2"]);
		expect(snapshot.transcript.map(({ id }) => id)).toEqual(["result-0"]);

		reduceLaneSnapshot(snapshot, end(1));
		expect(snapshot.operation.runningTools.every(({ status }) => status === "settled")).toBe(true);
		reduceLaneSnapshot(snapshot, entry(1));
		expect(snapshot.operation.runningTools.map(({ toolCallId }) => toolCallId)).toEqual(["call-2"]);
		reduceLaneSnapshot(snapshot, entry(2));
		expect(snapshot.operation.runningTools).toEqual([]);
		expect(snapshot.transcript.map(({ id }) => id)).toEqual(["result-0", "result-1", "result-2"]);
	});

	it("marks navigation completion for rebase", async () => {
		const { lane } = await createFixture();
		const snapshot = (await lane.watch(BACKGROUND_CONTEXT)).snapshot;
		const reduced = reduceLaneSnapshot(
			{
				...snapshot,
				operation: {
					id: "navigation",
					kind: "navigation",
					startedAt: 1,
					fromTipId: null,
					status: "open",
					runningTools: [],
				},
			},
			{
				type: "navigation_end",
				lane: "main",
				runId: "navigation",
				status: "completed",
				fromTipId: null,
				tipId: "target",
				endedAt: 2,
			},
		);
		expect(reduced).toBe("rebase");
	});
});
