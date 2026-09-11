import { createModels, fauxAssistantMessage, fauxProvider, type Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHarness, HarnessFault, InvalidLane, UnknownTarget } from "../../../src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT } from "../../../src/harness/context.ts";
import { Harness } from "../../../src/harness/runtime/harness.ts";
import { Lane } from "../../../src/harness/runtime/lane.ts";
import { MemorySessionRepo, MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type { LaneConfiguration, Session } from "../../../src/harness/session/types.ts";
import { branchTip, laneConfig, laneState, pendingEntry, setValue } from "../../../src/harness/session/values.ts";
import { deferred } from "./test-utils.ts";

const sessions: Session[] = [];

function harnessOptions(session: Session) {
	const provider = fauxProvider();
	const models = createModels();
	models.setProvider(provider.provider);
	return {
		session,
		models,
		model: provider.getModel(),
		thinkingLevel: "medium" as const,
		activeToolNames: ["read", "bash"],
	};
}

async function createSession(id = `session-${sessions.length}`): Promise<Session> {
	const session = new StorageBackedSession({ id, createdAt: 1, storageVersion: 1 }, new MemoryStorage());
	sessions.push(session);
	return session;
}

async function createHarness(session?: Session): Promise<Harness<object | undefined>> {
	session ??= await createSession();
	const created = await AgentHarness.create(harnessOptions(session), BACKGROUND_CONTEXT);
	if (!(created.harness instanceof Harness)) throw new Error("Expected runtime Harness");
	return created.harness;
}

const configured = {
	model: { provider: "faux", modelId: "faux-1" },
	thinkingLevel: "low",
	activeToolNames: ["read"],
} satisfies LaneConfiguration;

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime Harness lane management", () => {
	it("attaches to a fresh Session without creating an implicit main lane", async () => {
		const session = await createSession();
		const harness = await createHarness(session);

		expect(await harness.lanes(BACKGROUND_CONTEXT)).toEqual([]);
		expect(await session.branch("main", BACKGROUND_CONTEXT)).toBeUndefined();
		expect("accept" in harness).toBe(false);
		expect("getTipId" in harness).toBe(false);
		expect("appendMessage" in harness).toBe(false);
	});

	it("atomically gets or creates a complete AgentLane", async () => {
		const session = await createSession();
		const harness = await createHarness(session);
		const events: string[] = [];
		harness.events.on("lane_created", (event) => {
			events.push(event.lane);
		});

		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		const same = await harness.lane("main", { createAt: "ignored" }, BACKGROUND_CONTEXT);

		expect(lane).toBeInstanceOf(Lane);
		expect(same).toBe(lane);
		expect(await lane.getTipId(BACKGROUND_CONTEXT)).toBeNull();
		expect(await lane.getThinkingLevel(BACKGROUND_CONTEXT)).toBe("medium");
		expect(await lane.getActiveTools(BACKGROUND_CONTEXT)).toEqual(["read", "bash"]);
		expect((await session.getValue(laneState("main"), BACKGROUND_CONTEXT))?.value).toEqual({
			currentOperationId: null,
			lastOperationId: null,
			inbox: [],
		});
		expect(events).toEqual(["main"]);
		expect(await harness.lanes(BACKGROUND_CONTEXT)).toMatchObject([{ name: "main", tipId: null }]);
	});

	it("returns one published AgentLane under concurrent acquisition", async () => {
		const session = await createSession();
		const harness = await createHarness(session);
		const listener = vi.fn();
		harness.events.on("lane_created", listener);

		const [first, second, third] = await Promise.all([
			harness.lane("main", BACKGROUND_CONTEXT),
			harness.lane("main", BACKGROUND_CONTEXT),
			harness.lane("main", BACKGROUND_CONTEXT),
		]);

		expect(second).toBe(first);
		expect(third).toBe(first);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("uses one stable provider session id per lane", async () => {
		const session = await createSession("shared-session");
		const faux = fauxProvider();
		faux.setResponses([
			fauxAssistantMessage("main one"),
			fauxAssistantMessage("main two"),
			fauxAssistantMessage("review"),
		]);
		const sessionIds: Array<string | undefined> = [];
		const base = faux.provider;
		const provider: Provider = {
			id: base.id,
			name: base.name,
			auth: base.auth,
			getModels: () => base.getModels(),
			stream: (model, context, options) => base.stream(model, context, options),
			streamSimple: (model, context, options) => {
				sessionIds.push(options?.sessionId);
				return base.streamSimple(model, context, options);
			},
		};
		const models = createModels();
		models.setProvider(provider);
		const created = await AgentHarness.create(
			{ session, models, model: faux.getModel(), activeToolNames: [] },
			BACKGROUND_CONTEXT,
		);
		const main = await created.harness.lane("main", BACKGROUND_CONTEXT);
		const review = await created.harness.lane("review", BACKGROUND_CONTEXT);

		await main.prompt("one", undefined, BACKGROUND_CONTEXT);
		await main.prompt("two", undefined, BACKGROUND_CONTEXT);
		await review.prompt("review", undefined, BACKGROUND_CONTEXT);

		expect(sessionIds).toEqual(["shared-session:main", "shared-session:main", "shared-session:review"]);
	});

	it("serializes commands from different AgentLanes on the one Session line", async () => {
		const harness = await createHarness();
		const main = await harness.lane("main", BACKGROUND_CONTEXT);
		const review = await harness.lane("review", BACKGROUND_CONTEXT);
		if (!(main instanceof Lane) || !(review instanceof Lane)) throw new Error("Expected runtime Lanes");
		const started = deferred();
		const gate = deferred();
		const order: string[] = [];
		const first = main.command(async () => {
			order.push("main:start");
			started.resolve();
			await gate.promise;
			order.push("main:end");
			return { kind: "return", result: undefined };
		}, BACKGROUND_CONTEXT);
		await started.promise;
		const second = review.command(() => {
			order.push("review");
			return { kind: "return", result: undefined };
		}, BACKGROUND_CONTEXT);
		await Promise.resolve();
		expect(order).toEqual(["main:start"]);
		gate.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["main:start", "main:end", "review"]);
	});

	it("uses createAt only for a missing lane and validates the target", async () => {
		const session = await createSession();
		await session.mutate(
			(mutator) =>
				mutator.commit(
					[
						{
							kind: "entry",
							entry: {
								id: "target",
								parentId: null,
								type: "custom",
								customType: "target",
							},
						},
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);
		const harness = await createHarness(session);
		const lane = await harness.lane("review", { createAt: "target" }, BACKGROUND_CONTEXT);

		expect(await lane.getTipId(BACKGROUND_CONTEXT)).toBe("target");
		expect(await harness.lane("review", { createAt: "missing" }, BACKGROUND_CONTEXT)).toBe(lane);
		await expect(harness.lane("missing", { createAt: "unknown" }, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(
			UnknownTarget,
		);
		await expect(harness.lane("", BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(InvalidLane);
		await expect(harness.lane("bad\u0000name", BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(InvalidLane);
	});

	it("attaches agent state to a data-only Branch without moving its tip", async () => {
		const session = await createSession();
		await session.mutate(
			(mutator) =>
				mutator.commit(
					[
						{
							kind: "entry",
							entry: {
								id: "target",
								parentId: null,
								type: "custom",
								customType: "target",
							},
						},
						setValue(branchTip("main"), "target"),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);
		const harness = await createHarness(session);

		expect(await harness.lanes(BACKGROUND_CONTEXT)).toEqual([]);
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		expect(await lane.getTipId(BACKGROUND_CONTEXT)).toBe("target");
		expect((await session.getValue(laneConfig("main"), BACKGROUND_CONTEXT))?.value).toEqual({
			model: { provider: "faux", modelId: "faux-1" },
			thinkingLevel: "medium",
			activeToolNames: ["read", "bash"],
		});
	});

	it("keeps AgentLane appends operation-aware while exposing the Branch surface directly", async () => {
		const session = await createSession();
		const harness = await createHarness(session);
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		const idleId = await lane.appendCustomEntry("idle", undefined, BACKGROUND_CONTEXT);
		expect(await lane.getTipId(BACKGROUND_CONTEXT)).toBe(idleId);

		const admission = await lane.accept({ kind: "prompt", prompt: "run" }, BACKGROUND_CONTEXT);
		if (!admission.ok) throw admission.error;
		const acceptedTip = await lane.getTipId(BACKGROUND_CONTEXT);
		const pendingId = await lane.appendCustomEntry("pending", { queued: true }, BACKGROUND_CONTEXT);

		expect(await lane.getTipId(BACKGROUND_CONTEXT)).toBe(acceptedTip);
		expect((await session.getValue(branchTip("main"), BACKGROUND_CONTEXT))?.value).toBe(acceptedTip);
		expect((await session.getValue(pendingEntry(pendingId), BACKGROUND_CONTEXT))?.value).toEqual({
			type: "custom",
			customType: "pending",
			payload: { queued: true },
		});
		expect((await session.getValue(laneState("main"), BACKGROUND_CONTEXT))?.value.inbox).toEqual([
			{ entryId: pendingId, kind: "write" },
		]);
	});

	it("flushes queued writes before a new idle append in one commit", async () => {
		const session = await createSession();
		const harness = await createHarness(session);
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		if (!(lane instanceof Lane)) throw new Error("Expected runtime Lane");
		const first = session.idGenerator.next();
		const second = session.idGenerator.next();
		await lane.command((state) => {
			const inbox = [
				{ entryId: first, kind: "write" as const },
				{ entryId: second, kind: "write" as const },
			];
			return {
				kind: "commit",
				writes: [
					setValue(pendingEntry(first), { type: "custom", customType: "queued-first" }),
					setValue(pendingEntry(second), { type: "custom", customType: "queued-second" }),
					setValue(laneState("main"), { currentOperationId: null, lastOperationId: null, inbox }),
				],
				next: { ...state, inbox },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);

		const appended = await lane.appendCustomEntry("new", undefined, BACKGROUND_CONTEXT);

		expect((await lane.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT)).map((entry) => entry.id)).toEqual([
			first,
			second,
			appended,
		]);
		expect(lane.state.inbox).toEqual([]);
		expect((await session.getValue(laneState("main"), BACKGROUND_CONTEXT))?.value.inbox).toEqual([]);
		expect(await session.getValue(pendingEntry(first), BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await session.getValue(pendingEntry(second), BACKGROUND_CONTEXT)).toBeUndefined();
	});

	it("restores complete lanes without requiring main", async () => {
		const session = await createSession();
		await session.mutate(
			(mutator) =>
				mutator.commit(
					[
						setValue(branchTip("review"), null),
						setValue(laneConfig("review"), configured),
						setValue(laneState("review"), {
							currentOperationId: null,
							lastOperationId: null,
							inbox: [],
						}),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);

		const { harness, open } = await AgentHarness.create(harnessOptions(session), BACKGROUND_CONTEXT);
		expect(open).toEqual([]);
		expect((await harness.lanes(BACKGROUND_CONTEXT)).map(({ name }) => name)).toEqual(["review"]);
		expect(await harness.lane("review", BACKGROUND_CONTEXT)).toBeDefined();
		expect(await session.branch("main", BACKGROUND_CONTEXT)).toBeUndefined();
	});

	it("rejects partial durable lane state as a Harness fault", async () => {
		const session = await createSession();
		await session.mutate(
			(mutator) =>
				mutator.commit(
					[setValue(branchTip("main"), null), setValue(laneConfig("main"), configured)],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);

		await expect(AgentHarness.create(harnessOptions(session), BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(
			HarnessFault,
		);
	});
});

describe("runtime Harness global metadata", () => {
	it("preserves value_update publication and delivery", async () => {
		const session = await createSession();
		const harness = await createHarness(session);
		const seen: string[] = [];
		harness.events.on("value_update", async (event) => {
			seen.push(event.value === "session_name" ? `name:${await harness.getName(BACKGROUND_CONTEXT)}` : event.value);
		});

		await harness.setName("named", BACKGROUND_CONTEXT);
		await harness.setLabel("entry", "label", BACKGROUND_CONTEXT);

		expect(await harness.getName(BACKGROUND_CONTEXT)).toBe("named");
		expect(await harness.getLabel("entry", BACKGROUND_CONTEXT)).toBe("label");
		expect(seen).toEqual(["name:named", "entry_label"]);
	});

	it("publishes previous and current data-bearing global configuration", async () => {
		const harness = await createHarness();
		const events: unknown[] = [];
		harness.events.on("config_update", (event) => {
			events.push(event);
		});

		await harness.setStreamOptions({ timeoutMs: 123 }, BACKGROUND_CONTEXT);
		await harness.setSteeringMode("one-at-a-time", BACKGROUND_CONTEXT);

		expect(events).toEqual([
			expect.objectContaining({
				type: "config_update",
				property: "streamOptions",
				previous: {},
				value: { timeoutMs: 123 },
			}),
			expect.objectContaining({
				type: "config_update",
				property: "steeringMode",
				previous: "all",
				value: "one-at-a-time",
			}),
		]);
	});

	it("closes every lane and rejects later acquisition", async () => {
		const harness = await createHarness();
		const lane = await harness.lane("main", BACKGROUND_CONTEXT);
		await harness.close(BACKGROUND_CONTEXT);

		await expect(harness.lane("other", BACKGROUND_CONTEXT)).rejects.toThrow("closed");
		await expect(lane.getTipId(BACKGROUND_CONTEXT)).rejects.toThrow("closed");
	});

	it("MemorySessionRepo creation also remains branchless", async () => {
		const repo = new MemorySessionRepo();
		const session = await repo.create({ id: "repo-session" }, BACKGROUND_CONTEXT);
		expect(await session.branch("main", BACKGROUND_CONTEXT)).toBeUndefined();
		await session.close(BACKGROUND_CONTEXT);
		await repo.close(BACKGROUND_CONTEXT);
	});
});
