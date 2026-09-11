import { type Api, createModels, fauxProvider, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessClosed, type HarnessEvent } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT, type Context } from "../../../src/harness/context.ts";
import { HarnessEventBus } from "../../../src/harness/events.ts";
import { HookRegistry } from "../../../src/harness/hooks.ts";
import { convertToLlm } from "../../../src/harness/messages.ts";
import { Lane } from "../../../src/harness/runtime/lane.ts";
import { restoreLane } from "../../../src/harness/runtime/restore.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type { LaneConfiguration, Session, StartingOperation } from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";
import { ControlledMemoryStorage, deferred } from "./test-utils.ts";

const sessions: Session[] = [];
const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

async function createLane(
	emitBatch: (events: readonly HarnessEvent[], context: Context) => Promise<void> = () => Promise.resolve(),
): Promise<{
	lane: Lane<undefined>;
	model: Model<Api>;
	session: Session;
	storage: ControlledMemoryStorage;
}> {
	const storage = new ControlledMemoryStorage();
	const session = new StorageBackedSession(
		{ id: `runtime-lane-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	sessions.push(session);
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
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return {
		lane: new Lane<undefined>(
			"main",
			session,
			models,
			new HookRegistry(() => {}),
			await restoreLane(session, "main", BACKGROUND_CONTEXT),
			(cause) => (cause instanceof Error ? cause : new Error(String(cause))),
			emitBatch,
			(snapshot) => ({
				snapshot,
				start: () => {},
				resnapshot: () => Promise.resolve(snapshot),
				unsubscribe: () => {},
			}),
			() => ({
				tools: [],
				resources: {},
				streamOptions: {},
				retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 1_000 },
				compaction: DEFAULT_COMPACTION_SETTINGS,
				steeringMode: "all",
				followUpMode: "all",
				toolExecution: "parallel",
				toolContext: undefined,
				systemPrompt: undefined,
				toProviderMessages: (messages) => convertToLlm(messages),
				entryProjectors: {},
			}),
		),
		model: faux.getModel(),
		session,
		storage,
	};
}

function setThinkingLevel(
	lane: Lane<undefined>,
	thinkingLevel: LaneConfiguration["thinkingLevel"],
	observed?: LaneConfiguration["thinkingLevel"][],
): Promise<LaneConfiguration["thinkingLevel"]> {
	return lane.command((state) => {
		observed?.push(state.configuration.thinkingLevel);
		const next = { ...state, configuration: { ...state.configuration, thinkingLevel } };
		return {
			kind: "commit",
			writes: [storedValues.setValue(storedValues.laneConfig(lane.name), next.configuration)],
			next,
			materialize: () => thinkingLevel,
		};
	}, BACKGROUND_CONTEXT);
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime Lane commands", () => {
	it("reads and replaces configuration from owned state", async () => {
		const { lane, model, session } = await createLane();
		const activeToolNames = ["read"];

		await lane.setModel({ provider: model.provider, modelId: model.id }, BACKGROUND_CONTEXT);
		await lane.setThinkingLevel("high", BACKGROUND_CONTEXT);
		await lane.setActiveTools(activeToolNames, BACKGROUND_CONTEXT);

		expect(await lane.getModel(BACKGROUND_CONTEXT)).toBe(model);
		expect(await lane.getThinkingLevel(BACKGROUND_CONTEXT)).toBe("high");
		expect(await lane.getActiveTools(BACKGROUND_CONTEXT)).toBe(activeToolNames);
		expect((await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT))?.value).toEqual({
			model: { provider: model.provider, modelId: model.id },
			thinkingLevel: "high",
			activeToolNames,
		});
	});

	it("derives queued configuration updates from the latest committed state", async () => {
		const { lane, model, storage } = await createLane();
		const commitStarted = deferred();
		const releaseCommit = deferred();
		storage.beforeNextCommit = async () => {
			commitStarted.resolve();
			await releaseCommit.promise;
		};

		const modelUpdate = lane.setModel({ provider: model.provider, modelId: model.id }, BACKGROUND_CONTEXT);
		await commitStarted.promise;
		const thinkingUpdate = lane.setThinkingLevel("high", BACKGROUND_CONTEXT);
		releaseCommit.resolve();
		await Promise.all([modelUpdate, thinkingUpdate]);

		expect(lane.state.configuration).toEqual({
			model: { provider: model.provider, modelId: model.id },
			thinkingLevel: "high",
			activeToolNames: [],
		});
	});

	it("returns a promise value without holding the lane line", async () => {
		const { lane } = await createLane();
		const completion = deferred();
		let completed = false;
		const joined = lane
			.command(() => ({ kind: "return", result: completion.promise }), BACKGROUND_CONTEXT)
			.then(() => {
				completed = true;
			});

		await lane.setThinkingLevel("high", BACKGROUND_CONTEXT);
		expect(completed).toBe(false);
		completion.resolve();
		await joined;
	});

	it("returns an expected rejection without faulting the lane", async () => {
		const { lane } = await createLane();
		const rejection = new Error("declined");

		await expect(lane.command(() => ({ kind: "reject", error: rejection }), BACKGROUND_CONTEXT)).rejects.toBe(
			rejection,
		);
		expect(await lane.getTipId(BACKGROUND_CONTEXT)).toBeNull();
		await lane.setThinkingLevel("high", BACKGROUND_CONTEXT);
	});

	it("passes bounded reads and commit metadata through the serialized command", async () => {
		const { lane } = await createLane();
		let storedConfiguration: LaneConfiguration | undefined;
		let memoryPublished = false;

		const commit = await lane.command(async (state, reader) => {
			storedConfiguration = (await reader.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT))?.value;
			const configuration: LaneConfiguration = { ...state.configuration, thinkingLevel: "high" };
			const next = { ...state, configuration };
			return {
				kind: "commit",
				writes: [storedValues.setValue(storedValues.laneConfig("main"), configuration)],
				next,
				materialize: (commit) => {
					memoryPublished = lane.state === next;
					return commit;
				},
			};
		}, BACKGROUND_CONTEXT);

		expect(storedConfiguration).toEqual(configuration);
		expect(memoryPublished).toBe(true);
		expect(commit.seqs).toHaveLength(1);
		expect(commit.timestamp).toEqual(expect.any(Number));
	});

	it("rejects thenable materialization after publishing committed memory", async () => {
		const { lane, session } = await createLane();

		await expect(
			// @ts-expect-error Exercise the runtime guard against untyped callers.
			lane.command((state) => {
				const configuration: LaneConfiguration = { ...state.configuration, thinkingLevel: "high" };
				return {
					kind: "commit",
					writes: [storedValues.setValue(storedValues.laneConfig("main"), configuration)],
					next: { ...state, configuration },
					materialize: async () => undefined,
				};
			}, BACKGROUND_CONTEXT),
		).rejects.toThrow("Lane command materialize() must be synchronous");

		expect(lane.state.configuration.thinkingLevel).toBe("high");
		expect((await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT))?.value.thinkingLevel).toBe(
			"high",
		);
	});

	it("preserves committed memory when synchronous event publication fails", async () => {
		const bus = new HarnessEventBus();
		const { lane, session } = await createLane((events, context) => bus.emitBatch(events, context));
		const uncloneable = {
			type: "run_start",
			runId: "run",
			lane: "main",
			invalid: () => undefined,
		} as unknown as HarnessEvent;

		await expect(
			lane.command((state) => {
				const configuration: LaneConfiguration = { ...state.configuration, thinkingLevel: "high" };
				return {
					kind: "commit",
					writes: [storedValues.setValue(storedValues.laneConfig("main"), configuration)],
					next: { ...state, configuration },
					materialize: () => undefined,
					events: () => [uncloneable],
				};
			}, BACKGROUND_CONTEXT),
		).rejects.toMatchObject({ name: "DataCloneError" });

		expect(lane.state.configuration.thinkingLevel).toBe("high");
		expect((await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT))?.value.thinkingLevel).toBe(
			"high",
		);
	});

	it("rejects work after sealing while an admitted commit finishes", async () => {
		const { lane, storage } = await createLane();
		const commitStarted = deferred();
		const releaseCommit = deferred();
		storage.beforeNextCommit = async () => {
			commitStarted.resolve();
			await releaseCommit.promise;
		};

		const admitted = setThinkingLevel(lane, "high");
		await commitStarted.promise;
		const closed = new HarnessClosed();
		lane.seal(closed);

		await expect(lane.getTipId(BACKGROUND_CONTEXT)).rejects.toBe(closed);
		await expect(lane.setThinkingLevel("low", BACKGROUND_CONTEXT)).rejects.toBe(closed);
		releaseCommit.resolve();
		await admitted;
		expect(lane.state.configuration.thinkingLevel).toBe("high");
	});

	it("publishes memory only after the durable commit succeeds", async () => {
		const { lane, session, storage } = await createLane();
		const commitStarted = deferred();
		const releaseCommit = deferred();
		storage.beforeNextCommit = async () => {
			commitStarted.resolve();
			await releaseCommit.promise;
		};

		const command = setThinkingLevel(lane, "high");
		await commitStarted.promise;

		expect(lane.state.configuration.thinkingLevel).toBe("off");
		releaseCommit.resolve();
		expect(await command).toBe("high");
		expect(lane.state.configuration.thinkingLevel).toBe("high");
		expect((await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT))?.value.thinkingLevel).toBe(
			"high",
		);
	});

	it("preserves memory when the durable commit fails", async () => {
		const { lane, session, storage } = await createLane();
		const failure = new Error("commit failed");
		storage.beforeNextCommit = async () => {
			throw failure;
		};

		await expect(setThinkingLevel(lane, "high")).rejects.toBe(failure);

		expect(lane.state.configuration.thinkingLevel).toBe("off");
		expect((await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT))?.value.thinkingLevel).toBe(
			"off",
		);
	});

	it("diverts ordinary work but settles against latest cancelled control", async () => {
		const { lane, session } = await createLane();
		const accepted = await lane.accept({ kind: "prompt", prompt: "hello" }, BACKGROUND_CONTEXT);
		expect(accepted.ok).toBe(true);
		const operation = lane.state.operation;
		if (operation?.state.at !== "starting") throw new Error("missing accepted operation");
		const cancelled: StartingOperation = {
			...operation.state,
			control: { status: "cancel_requested", requestedAt: 1 },
		};
		await lane.command(
			(state) => ({
				kind: "commit",
				writes: [storedValues.setValue(storedValues.operationState(operation.meta.operationId), cancelled)],
				next: { ...state, operation: { meta: operation.meta, state: cancelled } },
				materialize: () => undefined,
			}),
			BACKGROUND_CONTEXT,
		);

		let continued = false;
		expect(
			await lane.continueOperation(
				cancelled,
				() => {
					continued = true;
					return { kind: "return", result: "continued" };
				},
				BACKGROUND_CONTEXT,
			),
		).toEqual({ kind: "cancel_requested" });
		expect(continued).toBe(false);

		const settled = await lane.settleOperation(
			cancelled,
			(state, current) => {
				expect(current.control.status).toBe("cancel_requested");
				const inbox = [...state.inbox, { entryId: "accepted-during-cancellation", kind: "write" as const }];
				return {
					kind: "commit",
					writes: [],
					operationState: current,
					lane: { inbox },
					materialize: () => inbox,
				};
			},
			BACKGROUND_CONTEXT,
		);
		expect(settled).toEqual([{ entryId: "accepted-during-cancellation", kind: "write" }]);
		expect(lane.state.inbox).toEqual(settled);
		expect((await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT))?.value.inbox).toEqual(
			settled,
		);
	});

	it("plans queued commands from the latest committed memory", async () => {
		const { lane, storage } = await createLane();
		const commitStarted = deferred();
		const releaseCommit = deferred();
		const observed: LaneConfiguration["thinkingLevel"][] = [];
		storage.beforeNextCommit = async () => {
			commitStarted.resolve();
			await releaseCommit.promise;
		};

		const first = setThinkingLevel(lane, "high", observed);
		await commitStarted.promise;
		const second = setThinkingLevel(lane, "medium", observed);
		await Promise.resolve();
		expect(observed).toEqual(["off"]);

		releaseCommit.resolve();
		expect(await Promise.all([first, second])).toEqual(["high", "medium"]);
		expect(observed).toEqual(["off", "high"]);
		expect(lane.state.configuration.thinkingLevel).toBe("medium");
	});
});
