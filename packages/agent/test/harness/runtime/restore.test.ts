import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT } from "../../../src/harness/context.ts";
import { restoreLane, restoreSession } from "../../../src/harness/runtime/restore.ts";
import { MemorySessionRepo, MemoryStorage } from "../../../src/harness/session/memory.ts";
import type {
	CheckpointOperation,
	LaneConfiguration,
	OperationMeta,
	OperationScope,
	OperationState,
	ResultBoundary,
	Session,
} from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";

const repos: MemorySessionRepo[] = [];
const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

async function createSession(): Promise<Session> {
	const repo = new MemorySessionRepo();
	repos.push(repo);
	const session = await repo.create({}, BACKGROUND_CONTEXT);
	await session.mutate(
		(mutator) =>
			mutator.commit(
				[
					storedValues.setValue(storedValues.branchTip("main"), null),
					storedValues.setValue(storedValues.laneConfig("main"), configuration),
					storedValues.setValue(storedValues.laneState("main"), {
						currentOperationId: null,
						lastOperationId: null,
						inbox: [],
					}),
				],
				BACKGROUND_CONTEXT,
			),
		BACKGROUND_CONTEXT,
	);
	return session;
}

function operationScope(): OperationScope {
	return {
		control: { status: "running" },
		settings: {
			compaction: DEFAULT_COMPACTION_SETTINGS,
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: "parallel",
		},
		latestAssistantEntryId: null,
	};
}

function runState(triggerEntryId: string): CheckpointOperation {
	return {
		...operationScope(),
		at: "checkpoint",
		continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
		triggerEntryId,
	};
}

function summaryState(boundary: ResultBoundary): OperationState {
	return {
		...operationScope(),
		at: "summary.deciding",
		task: {
			taskId: "task",
			...(boundary.kind === "finish"
				? { reason: "manual" as const }
				: boundary.kind === "resume_checkpoint"
					? { reason: "threshold" as const }
					: {}),
			boundary,
		},
	};
}

afterEach(async () => {
	for (const repo of repos.splice(0)) await repo.close(BACKGROUND_CONTEXT);
});

describe("runtime lane restore", () => {
	it("restores an idle lane's latest operation id without reading its result", async () => {
		const session = await createSession();
		const result = {
			operationId: session.idGenerator.next(),
			kind: "navigation" as const,
			status: "completed" as const,
			fromTipId: null,
			tipId: null,
			startedAt: 1,
			endedAt: 2,
		};
		await session.mutate(
			(mutator) =>
				mutator.commit(
					[
						storedValues.setValue(storedValues.operationResult(result.operationId), result),
						storedValues.setValue(storedValues.laneState("main"), {
							currentOperationId: null,
							lastOperationId: result.operationId,
							inbox: [],
						}),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);

		const state = await restoreLane(session, "main", BACKGROUND_CONTEXT);

		expect(state).toEqual({
			tipId: null,
			configuration,
			inbox: [],
			lastOperationId: result.operationId,
			operation: null,
		});
	});

	it("restores an open operation without interpreting its referenced payloads", async () => {
		const session = await createSession();
		const operationId = session.idGenerator.next();
		const missingTriggerId = session.idGenerator.next();
		const meta: OperationMeta = {
			operationId,
			lane: "main",
			sourceTipId: null,
			startedAt: 1,
			intent: { kind: "run", promptEntryIds: [] },
		};
		const state = runState(missingTriggerId);
		await session.mutate(
			(mutator) =>
				mutator.commit(
					[
						storedValues.setValue(storedValues.operationMeta(operationId), meta),
						storedValues.setValue(storedValues.operationState(operationId), state),
						storedValues.setValue(storedValues.laneState("main"), {
							currentOperationId: operationId,
							lastOperationId: null,
							inbox: [],
						}),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);

		const restored = await restoreLane(session, "main", BACKGROUND_CONTEXT);

		expect(restored.operation).toEqual({ meta, state });
	});

	it("validates current-operation identity, lane ownership, and intent/state compatibility", async () => {
		for (const corruption of ["identity", "lane", "kind"] as const) {
			const session = await createSession();
			const operationId = session.idGenerator.next();
			const base: OperationMeta = {
				operationId,
				lane: "main",
				sourceTipId: null,
				startedAt: 1,
				intent: { kind: "run", promptEntryIds: [] },
			};
			const meta: OperationMeta =
				corruption === "identity"
					? { ...base, operationId: "different-operation" }
					: corruption === "lane"
						? { ...base, lane: "worker" }
						: { ...base, intent: { kind: "navigation", targetId: null, summarize: false } };
			await session.mutate(
				(mutator) =>
					mutator.commit(
						[
							storedValues.setValue(storedValues.operationMeta(operationId), meta),
							storedValues.setValue(storedValues.operationState(operationId), runState("trigger")),
							storedValues.setValue(storedValues.laneState("main"), {
								currentOperationId: operationId,
								lastOperationId: null,
								inbox: [],
							}),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			await expect(restoreLane(session, "main", BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(Error);
		}
	});

	it("accepts exactly the family-neutral state reachability matrix", async () => {
		const resume = { kind: "resume_checkpoint", resumeAfter: runState("trigger") } satisfies ResultBoundary;
		const finish = { kind: "finish" } satisfies ResultBoundary;
		const navigation = { kind: "commit_navigation", targetId: "target" } satisfies ResultBoundary;
		const cases: { intent: OperationMeta["intent"]; state: OperationState; accepted: boolean }[] = [
			{ intent: { kind: "run", promptEntryIds: [] }, state: runState("trigger"), accepted: true },
			{ intent: { kind: "run", promptEntryIds: [] }, state: summaryState(resume), accepted: true },
			{ intent: { kind: "run", promptEntryIds: [] }, state: summaryState(finish), accepted: false },
			{ intent: { kind: "run", promptEntryIds: [] }, state: summaryState(navigation), accepted: false },
			{ intent: { kind: "compaction" }, state: summaryState(finish), accepted: true },
			{ intent: { kind: "compaction" }, state: summaryState(resume), accepted: false },
			{ intent: { kind: "compaction" }, state: summaryState(navigation), accepted: false },
			{ intent: { kind: "compaction" }, state: runState("trigger"), accepted: false },
			{
				intent: { kind: "navigation", targetId: null, summarize: false },
				state: { ...operationScope(), at: "navigation.ready_to_commit", targetId: null },
				accepted: true,
			},
			{
				intent: { kind: "navigation", targetId: "target", summarize: false },
				state: { ...operationScope(), at: "navigation.ready_to_commit", targetId: "different" },
				accepted: false,
			},
			{
				intent: { kind: "navigation", targetId: "target", summarize: false },
				state: summaryState(navigation),
				accepted: false,
			},
			{
				intent: { kind: "navigation", targetId: "target", summarize: true },
				state: summaryState(navigation),
				accepted: true,
			},
			{
				intent: { kind: "navigation", targetId: "different", summarize: true },
				state: summaryState(navigation),
				accepted: false,
			},
			{
				intent: { kind: "navigation", targetId: "target", summarize: true },
				state: { ...operationScope(), at: "navigation.ready_to_commit", targetId: "target" },
				accepted: false,
			},
			{
				intent: { kind: "navigation", targetId: "target", summarize: true },
				state: summaryState(finish),
				accepted: false,
			},
			{
				intent: { kind: "navigation", targetId: "target", summarize: true },
				state: summaryState(resume),
				accepted: false,
			},
			{
				intent: { kind: "navigation", targetId: "target", summarize: false },
				state: runState("trigger"),
				accepted: false,
			},
		];

		for (const testCase of cases) {
			const session = await createSession();
			const operationId = session.idGenerator.next();
			const meta: OperationMeta = {
				operationId,
				lane: "main",
				sourceTipId: null,
				startedAt: 1,
				intent: testCase.intent,
			};
			await session.mutate(
				(mutator) =>
					mutator.commit(
						[
							storedValues.setValue(storedValues.operationMeta(operationId), meta),
							storedValues.setValue(storedValues.operationState(operationId), testCase.state),
							storedValues.setValue(storedValues.laneState("main"), {
								currentOperationId: operationId,
								lastOperationId: null,
								inbox: [],
							}),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);
			const restored = restoreLane(session, "main", BACKGROUND_CONTEXT);
			if (testCase.accepted)
				await expect(restored).resolves.toMatchObject({ operation: { meta, state: testCase.state } });
			else await expect(restored).rejects.toThrow("does not match state");
		}
	});

	it.each([
		[storedValues.branchTip("main").namespace, storedValues.deleteValue(storedValues.branchTip("main"))],
		[storedValues.laneConfig("main").namespace, storedValues.deleteValue(storedValues.laneConfig("main"))],
		[storedValues.laneState("main").namespace, storedValues.deleteValue(storedValues.laneState("main"))],
	] as const)("requires %s", async (namespace, write) => {
		const session = await createSession();
		await session.mutate((mutator) => mutator.commit([write], BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);

		await expect(restoreLane(session, "main", BACKGROUND_CONTEXT)).rejects.toThrow(`missing ${namespace.slice(3)}`);
	});

	it.each([storedValues.operationMeta("").namespace, storedValues.operationState("").namespace] as const)(
		"requires %s for the current operation",
		async (namespace) => {
			const session = await createSession();
			const operationId = session.idGenerator.next();
			const meta: OperationMeta = {
				operationId,
				lane: "main",
				sourceTipId: null,
				startedAt: 1,
				intent: { kind: "run", promptEntryIds: [] },
			};
			const state = runState(session.idGenerator.next());
			await session.mutate(
				(mutator) =>
					mutator.commit(
						[
							...(namespace === storedValues.operationMeta(operationId).namespace
								? []
								: [storedValues.setValue(storedValues.operationMeta(operationId), meta)]),
							...(namespace === storedValues.operationState(operationId).namespace
								? []
								: [storedValues.setValue(storedValues.operationState(operationId), state)]),
							storedValues.setValue(storedValues.laneState("main"), {
								currentOperationId: operationId,
								lastOperationId: null,
								inbox: [],
							}),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			await expect(restoreLane(session, "main", BACKGROUND_CONTEXT)).rejects.toThrow(
				`missing ${namespace.slice(3)}`,
			);
		},
	);

	it("restores every configured lane exactly once without writing", async () => {
		const session = await createSession();
		const workerConfiguration: LaneConfiguration = {
			model: { provider: "test", modelId: "worker" },
			thinkingLevel: "high",
			activeToolNames: ["read"],
		};
		await session.mutate(
			(mutator) =>
				mutator.commit(
					[
						storedValues.setValue(storedValues.branchTip("worker"), null),
						storedValues.setValue(storedValues.laneConfig("worker"), workerConfiguration),
						storedValues.setValue(storedValues.laneState("worker"), {
							currentOperationId: null,
							lastOperationId: null,
							inbox: [],
						}),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);
		const operationId = session.idGenerator.next();
		const meta: OperationMeta = {
			operationId,
			lane: "worker",
			sourceTipId: null,
			startedAt: 1,
			intent: { kind: "run", promptEntryIds: [] },
		};
		const state = runState(session.idGenerator.next());
		await session.mutate(
			(mutator) =>
				mutator.commit(
					[
						storedValues.setValue(storedValues.operationMeta(operationId), meta),
						storedValues.setValue(storedValues.operationState(operationId), state),
						storedValues.setValue(storedValues.laneState("worker"), {
							currentOperationId: operationId,
							lastOperationId: null,
							inbox: [],
						}),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);
		const before = {
			leaves: await session.scanValues(storedValues.branchTipInventoryPrefix(), BACKGROUND_CONTEXT),
			mainConfiguration: await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT),
			workerConfiguration: await session.getValue(storedValues.laneConfig("worker"), BACKGROUND_CONTEXT),
			mainState: await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT),
			workerState: await session.getValue(storedValues.laneState("worker"), BACKGROUND_CONTEXT),
		};
		const mutate = vi.spyOn(session, "mutate");
		const getValue = vi.spyOn(MemoryStorage.prototype, "getValue");
		const readList = vi.spyOn(MemoryStorage.prototype, "readList");

		const lanes = await restoreSession(session, BACKGROUND_CONTEXT);

		expect([...lanes.keys()].sort()).toEqual(["main", "worker"]);
		expect(lanes.get("main")?.configuration).toEqual(configuration);
		expect(lanes.get("worker")).toMatchObject({
			configuration: workerConfiguration,
			operation: { meta, state },
		});
		expect(mutate).toHaveBeenCalledTimes(1);
		expect(getValue.mock.calls.map(([address]) => ({ namespace: address.namespace, key: address.key }))).toEqual([
			{ namespace: storedValues.operationMeta("").namespace, key: operationId },
			{ namespace: storedValues.operationState("").namespace, key: operationId },
		]);
		expect(readList).not.toHaveBeenCalled();
		getValue.mockRestore();
		expect({
			leaves: await session.scanValues(storedValues.branchTipInventoryPrefix(), BACKGROUND_CONTEXT),
			mainConfiguration: await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT),
			workerConfiguration: await session.getValue(storedValues.laneConfig("worker"), BACKGROUND_CONTEXT),
			mainState: await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT),
			workerState: await session.getValue(storedValues.laneState("worker"), BACKGROUND_CONTEXT),
		}).toEqual(before);
		readList.mockRestore();
	});

	it("allows an empty inventory but rejects lane values without a Branch", async () => {
		const repo = new MemorySessionRepo();
		repos.push(repo);
		const empty = await repo.create({}, BACKGROUND_CONTEXT);
		await expect(restoreSession(empty, BACKGROUND_CONTEXT)).resolves.toEqual(new Map());

		const session = await createSession();
		await session.mutate(
			(mutator) => mutator.commit([storedValues.deleteValue(storedValues.branchTip("main"))], BACKGROUND_CONTEXT),
			BACKGROUND_CONTEXT,
		);
		await expect(restoreSession(session, BACKGROUND_CONTEXT)).rejects.toThrow('Lane "main" is missing branch.tip');
	});
});
