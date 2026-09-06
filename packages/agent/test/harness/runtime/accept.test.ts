import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HarnessEvent, HarnessFault, type OperationRequest } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT, createContextKey, withContextValue } from "../../../src/harness/context.ts";
import type { Result } from "../../../src/harness/result.ts";
import { createAgentHarness, Harness } from "../../../src/harness/runtime/harness.ts";
import { Lane } from "../../../src/harness/runtime/lane.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import { InstrumentedStorage } from "../../../src/harness/session/testing/index.ts";
import * as storedValues from "../../../src/harness/session/values.ts";
import type { AgentMessage, Session } from "../../../src/index.ts";
import { ControlledMemoryStorage, deferred, FailingMemoryStorage } from "./test-utils.ts";

const sessions: Session[] = [];
const configuration = {
	model: { provider: "faux", modelId: "faux-1" },
	thinkingLevel: "off" as const,
	activeToolNames: [],
};

async function createSession(storage = new InstrumentedStorage(new MemoryStorage())): Promise<{
	session: Session;
	storage: InstrumentedStorage;
}> {
	const session = new StorageBackedSession(
		{ id: `accept-${sessions.length}`, createdAt: 1, storageVersion: 1 },
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
	return { session, storage };
}

function options(session: Session) {
	const provider = fauxProvider();
	const models = createModels();
	models.setProvider(provider.provider);
	return { session, models, model: provider.getModel() };
}

async function createHarness(
	beforeCreate?: (session: Session) => Promise<void>,
	resources: Parameters<typeof createAgentHarness>[0]["resources"] = {},
	queueModes: { steeringMode?: "all" | "one-at-a-time"; followUpMode?: "all" | "one-at-a-time" } = {},
): Promise<{
	harness: Harness<object | undefined>;
	lane: Lane<object | undefined>;
	session: Session;
	storage: InstrumentedStorage;
	models: ReturnType<typeof createModels>;
}> {
	const created = await createSession();
	await beforeCreate?.(created.session);
	const harnessOptions = { ...options(created.session), resources, ...queueModes };
	const { harness } = await createAgentHarness(harnessOptions, BACKGROUND_CONTEXT);
	if (!(harness instanceof Harness)) throw new Error("Expected runtime Harness");
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	if (!(lane instanceof Lane)) throw new Error("Expected runtime Lane");
	created.storage.clearCommitAttempts();
	return { harness, lane, ...created, models: harnessOptions.models };
}

function unwrap<T>(result: Result<T, unknown>): T {
	if (!result.ok) throw result.error;
	return result.value;
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime atomic run acceptance", () => {
	it.each([
		["text", { kind: "prompt", prompt: "hello" } satisfies OperationRequest, [{ type: "text", text: "hello" }]],
		[
			"images",
			{
				kind: "prompt",
				prompt: "",
				images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			} satisfies OperationRequest,
			[{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
		],
		[
			"text and images",
			{
				kind: "prompt",
				prompt: "hello",
				images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			} satisfies OperationRequest,
			[
				{ type: "text", text: "hello" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
		],
	] as const)("accepts normalized %s prompts into starting", async (_name, request, expectedContent) => {
		const { lane, session } = await createHarness();

		const admission = unwrap(await lane.accept(request, BACKGROUND_CONTEXT));
		const operation = lane.state.operation;
		if (operation?.state.at !== "starting") throw new Error("Expected accepted run");
		const entryId = operation.meta.intent.kind === "run" ? operation.meta.intent.promptEntryIds[0] : undefined;
		if (entryId === undefined) throw new Error("Expected prompt entry");
		const entry = await session.getEntry(entryId, BACKGROUND_CONTEXT);

		expect(admission).toMatchObject({ operationId: operation.meta.operationId, kind: "run" });
		expect(entry).toMatchObject({ type: "message", message: { role: "user", content: expectedContent } });
		expect(operation.state.settings).toEqual({
			compaction: DEFAULT_COMPACTION_SETTINGS,
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: "parallel",
		});
	});

	it("preserves supplied message arrays and commits the exact acceptance write families once", async () => {
		const { harness, lane, storage, models } = await createHarness();
		const messages: AgentMessage[] = [
			{ role: "user", content: "one", timestamp: 10 },
			{ role: "user", content: "two", timestamp: 11 },
		];
		const getModel = vi.spyOn(models, "getModel");
		const contextKey = createContextKey<string>("accept.context");
		const context = withContextValue(contextKey, "source", BACKGROUND_CONTEXT);
		const seen: Array<{ event: HarnessEvent; sameContext: boolean }> = [];
		for (const type of ["run_start", "message_start", "message_end", "entry_added"] as const) {
			harness.events.on(type, (event, eventContext) => {
				seen.push({ event, sameContext: eventContext === context });
			});
		}

		const admission = unwrap(
			await lane.accept({ kind: "prompt", operationId: "operation", prompt: messages }, context),
		);

		expect(admission).toEqual({ operationId: "operation", kind: "run", startedAt: expect.any(Number) });
		expect(storage.getCommitAttempts()).toHaveLength(1);
		expect(
			storage
				.getCommitAttempts()[0]
				?.map((write) => (write.kind === "value" ? `${write.kind}:${write.op}` : write.kind)),
		).toEqual(["entry", "entry", "value:set", "value:set", "value:set", "value:set"]);
		const operation = lane.state.operation;
		if (operation?.meta.intent.kind !== "run") throw new Error("Expected run metadata");
		expect(operation.meta).toMatchObject({
			operationId: "operation",
			lane: "main",
			sourceTipId: null,
			intent: { promptEntryIds: expect.any(Array) },
		});
		expect(operation.meta.intent.promptEntryIds).toHaveLength(2);
		expect(await lane.getTipId(BACKGROUND_CONTEXT)).toBe(operation.meta.intent.promptEntryIds[1]);
		expect(seen.map(({ event }) => event.type)).toEqual([
			"run_start",
			"message_start",
			"message_end",
			"entry_added",
			"message_start",
			"message_end",
			"entry_added",
		]);
		expect(seen.every(({ sameContext }) => sameContext)).toBe(true);
		expect(getModel).not.toHaveBeenCalled();
	});

	it("captures next-run messages before request messages and accepts an otherwise empty request", async () => {
		const first = "pending-first";
		const second = "pending-second";
		const firstMessage = { role: "user" as const, content: "first", timestamp: 1 };
		const secondMessage = { role: "user" as const, content: "second", timestamp: 2 };
		const { harness, lane, session, storage } = await createHarness(async (source) => {
			await source.mutate(
				(mutator) =>
					mutator.commit(
						[
							storedValues.setValue(storedValues.pendingEntry(first), {
								type: "message",
								payload: firstMessage,
							}),
							storedValues.setValue(storedValues.pendingEntry(second), {
								type: "message",
								payload: secondMessage,
							}),
							storedValues.setValue(storedValues.laneState("main"), {
								currentOperationId: null,
								lastOperationId: null,
								inbox: [
									{ entryId: first, kind: "nextRun" },
									{ entryId: second, kind: "nextRun" },
								],
							}),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);
		});
		const events: string[] = [];
		harness.events.on("queue_update", (event) => {
			events.push(event.type);
		});

		unwrap(await lane.accept({ kind: "prompt", prompt: "" }, BACKGROUND_CONTEXT));

		const operation = lane.state.operation;
		if (operation?.meta.intent.kind !== "run" || operation.state.at !== "starting") {
			throw new Error("Expected accepted run");
		}
		expect(operation.meta.intent.promptEntryIds).toEqual([]);
		expect(operation.meta.sourceTipId).toBeNull();
		expect(lane.state.inbox).toEqual([]);
		expect(
			(await session.scanBranch({ start: second, order: "oldestFirst" }, BACKGROUND_CONTEXT)).map(({ id }) => id),
		).toEqual([first, second]);
		expect(await session.getValue(storedValues.pendingEntry(first), BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await session.getValue(storedValues.pendingEntry(second), BACKGROUND_CONTEXT)).toBeUndefined();
		expect(
			storage
				.getCommitAttempts()[0]
				?.map((write) => (write.kind === "value" ? `${write.kind}:${write.op}` : write.kind)),
		).toEqual(["entry", "entry", "value:delete", "value:delete", "value:set", "value:set", "value:set", "value:set"]);
		expect(events).toEqual(["queue_update"]);
	});

	it("captures every eligible tag by mode and preserves admission order before the request", async () => {
		const ids = {
			write: "queued-write",
			next: "queued-next",
			steer1: "queued-steer-1",
			steer2: "queued-steer-2",
			follow1: "queued-follow-1",
			follow2: "queued-follow-2",
		};
		const { lane, session } = await createHarness(
			async (source) => {
				await source.mutate(
					(mutator) =>
						mutator.commit(
							[
								storedValues.setValue(storedValues.pendingEntry(ids.write), {
									type: "custom",
									customType: "queued-write",
								}),
								...[ids.next, ids.steer1, ids.steer2, ids.follow1, ids.follow2].map((entryId) =>
									storedValues.setValue(storedValues.pendingEntry(entryId), {
										type: "message",
										payload: { role: "user", content: entryId, timestamp: 1 },
									}),
								),
								storedValues.setValue(storedValues.laneState("main"), {
									currentOperationId: null,
									lastOperationId: null,
									inbox: [
										{ entryId: ids.steer1, kind: "steer" },
										{ entryId: ids.write, kind: "write" },
										{ entryId: ids.next, kind: "nextRun" },
										{ entryId: ids.follow1, kind: "followUp" },
										{ entryId: ids.steer2, kind: "steer" },
										{ entryId: ids.follow2, kind: "followUp" },
									],
								}),
							],
							BACKGROUND_CONTEXT,
						),
					BACKGROUND_CONTEXT,
				);
			},
			{},
			{ steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" },
		);

		unwrap(await lane.accept({ kind: "prompt", prompt: "request" }, BACKGROUND_CONTEXT));

		const tipId = lane.state.tipId;
		if (tipId === null) throw new Error("Expected accepted tip");
		const entries = await session.scanBranch({ start: tipId, order: "oldestFirst" }, BACKGROUND_CONTEXT);
		expect(entries.map((entry) => entry.id)).toEqual([ids.steer1, ids.write, ids.next, ids.follow1, tipId]);
		expect(lane.state.inbox).toEqual([
			{ entryId: ids.steer2, kind: "steer" },
			{ entryId: ids.follow2, kind: "followUp" },
		]);
		expect((await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT))?.value.inbox).toEqual(
			lane.state.inbox,
		);
		for (const entryId of [ids.write, ids.next, ids.steer1, ids.follow1]) {
			expect(await session.getValue(storedValues.pendingEntry(entryId), BACKGROUND_CONTEXT)).toBeUndefined();
		}
		for (const entryId of [ids.steer2, ids.follow2]) {
			expect(await session.getValue(storedValues.pendingEntry(entryId), BACKGROUND_CONTEXT)).toBeDefined();
		}
	});

	it("does not let a lone queued write validate empty acceptance", async () => {
		const entryId = "queued-write";
		const { lane, session } = await createHarness(async (source) => {
			await source.mutate(
				(mutator) =>
					mutator.commit(
						[
							storedValues.setValue(storedValues.pendingEntry(entryId), {
								type: "custom",
								customType: "queued-write",
							}),
							storedValues.setValue(storedValues.laneState("main"), {
								currentOperationId: null,
								lastOperationId: null,
								inbox: [{ entryId, kind: "write" }],
							}),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);
		});

		const result = await lane.accept({ kind: "prompt", prompt: "" }, BACKGROUND_CONTEXT);

		expect(result).toMatchObject({ ok: false, error: { _tag: "InvalidMessage", reason: "empty" } });
		expect(lane.state.inbox).toEqual([{ entryId, kind: "write" }]);
		expect(await session.getValue(storedValues.pendingEntry(entryId), BACKGROUND_CONTEXT)).toBeDefined();
	});

	it("formats skills and templates before acceptance", async () => {
		const resources = {
			skills: [
				{ name: "review", description: "Review", content: "Inspect it", filePath: "/skills/review/SKILL.md" },
			],
			promptTemplates: [{ name: "fix", content: "Fix $1 then $@" }],
		};
		const skill = await createHarness(undefined, resources);
		unwrap(
			await skill.lane.accept(
				{ kind: "skill", name: "review", additionalInstructions: "Be strict" },
				BACKGROUND_CONTEXT,
			),
		);
		const skillEntry = await skill.session.getEntry(skill.lane.state.tipId!, BACKGROUND_CONTEXT);
		expect(skillEntry).toMatchObject({
			type: "message",
			message: { content: [{ type: "text", text: expect.stringContaining('<skill name="review"') }] },
		});

		const template = await createHarness(undefined, resources);
		unwrap(
			await template.lane.accept({ kind: "prompt_template", name: "fix", args: ["A", "B"] }, BACKGROUND_CONTEXT),
		);
		const templateEntry = await template.session.getEntry(template.lane.state.tipId!, BACKGROUND_CONTEXT);
		expect(templateEntry).toMatchObject({
			type: "message",
			message: { content: [{ type: "text", text: "Fix A then A B" }] },
		});
	});

	it("accepts standalone compaction with durable preparation and no execution", async () => {
		const { harness, lane, session, storage } = await createHarness();
		await lane.appendMessage({ role: "user", content: "history", timestamp: 1 }, BACKGROUND_CONTEXT);
		storage.clearCommitAttempts();
		const starts = vi.fn();
		harness.events.on("compaction_start", starts);

		const admission = unwrap(
			await lane.accept(
				{ kind: "compaction", operationId: "compaction", customInstructions: "focus" },
				BACKGROUND_CONTEXT,
			),
		);

		expect(admission).toEqual({ operationId: "compaction", kind: "compaction", startedAt: expect.any(Number) });
		const operation = lane.state.operation;
		if (operation?.state.at !== "summary.deciding") throw new Error("Expected accepted compaction");
		expect(operation.state.task).toMatchObject({
			reason: "manual",
			customInstructions: "focus",
			boundary: { kind: "finish" },
		});
		expect(
			await session.getValue(
				storedValues.operationPreparation("compaction", operation.state.task.taskId),
				BACKGROUND_CONTEXT,
			),
		).toMatchObject({ value: { kind: "compaction" } });
		expect(storage.getCommitAttempts()).toHaveLength(1);
		expect(starts).toHaveBeenCalledTimes(1);
		expect(lane.activeDrive).toBeUndefined();
	});

	it("rejects empty standalone compaction without writing", async () => {
		const { lane, storage } = await createHarness();

		expect(await lane.accept({ kind: "compaction" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "NothingToCompact" },
		});
		expect(storage.getCommitAttempts()).toEqual([]);
	});

	it.each([false, true])("accepts %s summarized navigation atomically", async (summarize) => {
		const { harness, lane, session, storage } = await createHarness(async (source) => {
			await source.mutate(
				(mutator) =>
					mutator.commit(
						[
							{
								kind: "entry",
								entry: {
									id: "root",
									parentId: null,
									type: "message",
									message: { role: "user", content: "root", timestamp: 1 },
								},
							},
							{
								kind: "entry",
								entry: {
									id: "source",
									parentId: "root",
									type: "message",
									message: { role: "user", content: "source", timestamp: 2 },
								},
							},
							{
								kind: "entry",
								entry: {
									id: "target",
									parentId: "root",
									type: "message",
									message: { role: "user", content: "target", timestamp: 3 },
								},
							},
							storedValues.setValue(storedValues.branchTip("main"), "source"),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);
		});
		storage.clearCommitAttempts();
		const starts = vi.fn();
		harness.events.on("navigation_start", starts);

		unwrap(
			await lane.accept(
				{
					kind: "navigation",
					operationId: summarize ? "summarized" : "direct",
					targetId: "target",
					options: { summarize, label: "chosen", customInstructions: "focus" },
				},
				BACKGROUND_CONTEXT,
			),
		);

		const operation = lane.state.operation;
		if (operation === null) throw new Error("Expected accepted navigation");
		expect(operation.state.at).toBe(summarize ? "summary.deciding" : "navigation.ready_to_commit");
		expect(lane.state.tipId).toBe("source");
		if (summarize) {
			if (operation.state.at !== "summary.deciding") throw new Error("Expected summary decision");
			expect(
				await session.getValue(
					storedValues.operationPreparation(operation.meta.operationId, operation.state.task.taskId),
					BACKGROUND_CONTEXT,
				),
			).toMatchObject({ value: { kind: "branch_summary", messages: [{ content: "source" }] } });
		}
		expect(storage.getCommitAttempts()).toHaveLength(1);
		expect(starts).toHaveBeenCalledTimes(1);
		expect(lane.activeDrive).toBeUndefined();
	});

	it("validates navigation before acceptance", async () => {
		const { lane, storage } = await createHarness(async (source) => {
			await source.mutate(
				(mutator) =>
					mutator.commit(
						[
							{
								kind: "entry",
								entry: {
									id: "source",
									parentId: null,
									type: "message",
									message: { role: "user", content: "source", timestamp: 1 },
								},
							},
							storedValues.setValue(storedValues.branchTip("main"), "source"),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);
		});

		expect(await lane.accept({ kind: "navigation", targetId: "source" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "InvalidNavigation", reason: "current_tip" },
		});
		expect(
			await lane.accept({ kind: "navigation", targetId: null, options: { label: "bad" } }, BACKGROUND_CONTEXT),
		).toMatchObject({
			ok: false,
			error: { _tag: "InvalidNavigation", reason: "root_label" },
		});
		expect(await lane.accept({ kind: "navigation", targetId: "missing" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "UnknownTarget" },
		});
		expect(storage.getCommitAttempts()).toEqual([]);
	});

	it("returns expected pre-acceptance errors without writing", async () => {
		const { lane, storage } = await createHarness();
		const pending = fauxAssistantMessage([], { stopReason: "pending" });

		expect(await lane.accept({ kind: "prompt", prompt: "" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "InvalidMessage", reason: "empty" },
		});
		expect(await lane.accept({ kind: "prompt", prompt: pending }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "InvalidMessage", reason: "pending_assistant" },
		});
		expect(await lane.accept({ kind: "skill", name: "missing" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "UnknownSkill" },
		});
		expect(await lane.accept({ kind: "prompt_template", name: "missing" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "UnknownTemplate" },
		});
		expect(storage.getCommitAttempts()).toEqual([]);
	});

	it("serializes concurrent accepts so exactly one wins", async () => {
		const { lane, storage } = await createHarness();

		const results = await Promise.all([
			lane.accept({ kind: "prompt", prompt: "first" }, BACKGROUND_CONTEXT),
			lane.accept({ kind: "prompt", prompt: "second" }, BACKGROUND_CONTEXT),
		]);

		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok)).toMatchObject([{ error: { _tag: "LaneBusy" } }]);
		expect(storage.getCommitAttempts()).toHaveLength(1);
	});

	it("faults on commit failure without publishing acceptance", async () => {
		const storage = new FailingMemoryStorage();
		const session = new StorageBackedSession({ id: "failing", createdAt: 1, storageVersion: 1 }, storage);
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
		const { harness } = await createAgentHarness(options(session), BACKGROUND_CONTEXT);
		if (!(harness instanceof Harness)) throw new Error("Expected runtime Harness");
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		if (!(lane instanceof Lane)) throw new Error("Expected runtime Lane");
		storage.failure = new Error("accept failed");

		await expect(lane.accept({ kind: "prompt", prompt: "hello" }, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(
			HarnessFault,
		);
		expect(lane.state.operation).toBeNull();
	});

	it("delivers acceptance listeners after publishing state and permits serialized reads", async () => {
		const { harness, lane } = await createHarness();
		let inspected = false;
		harness.events.on("run_start", async () => {
			inspected = (await lane.inspectExecution(BACKGROUND_CONTEXT)).current?.status === "open";
		});

		unwrap(await lane.accept({ kind: "prompt", prompt: "hello" }, BACKGROUND_CONTEXT));

		expect(inspected).toBe(true);
	});

	it("does not resolve acceptance before its direct listeners settle", async () => {
		const { harness, lane } = await createHarness();
		const started = deferred();
		const release = deferred();
		harness.events.on("run_start", async () => {
			started.resolve();
			await release.promise;
		});

		const acceptance = lane.accept({ kind: "prompt", prompt: "hello" }, BACKGROUND_CONTEXT);
		await started.promise;
		let resolved = false;
		void acceptance.then(() => {
			resolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(resolved).toBe(false);
		release.resolve();
		unwrap(await acceptance);
		expect(resolved).toBe(true);
	});

	it("returns Closed when acceptance starts after close", async () => {
		const { harness, lane, storage } = await createHarness();
		await harness.close(BACKGROUND_CONTEXT);

		expect(await lane.accept({ kind: "prompt", prompt: "late" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "Closed" },
		});
		expect(storage.getCommitAttempts()).toEqual([]);
	});

	it("publishes an acceptance admitted before close", async () => {
		const storage = new ControlledMemoryStorage();
		const session = new StorageBackedSession({ id: "closing", createdAt: 1, storageVersion: 1 }, storage);
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
		const { harness } = await createAgentHarness(options(session), BACKGROUND_CONTEXT);
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		const started = deferred();
		const release = deferred();
		storage.beforeNextCommit = async () => {
			started.resolve();
			await release.promise;
		};
		const acceptance = lane.accept({ kind: "prompt", prompt: "hello" }, BACKGROUND_CONTEXT);
		await started.promise;
		const closing = harness.close(BACKGROUND_CONTEXT);
		release.resolve();

		expect((await acceptance).ok).toBe(true);
		await closing;
	});
});
