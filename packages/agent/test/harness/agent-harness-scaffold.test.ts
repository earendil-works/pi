import type { Api, AssistantMessage, AssistantMessageEvent, Model, Models, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { EventStream } from "../../../ai/src/utils/event-stream.ts";
import { AgentHarness, type HarnessTool, type Resources } from "../../src/harness/agent-harness.ts";
import {
	InMemorySessionStorage,
	type NewRecord,
	type OperationStartedRecord,
	Session,
} from "../../src/harness/session/index.ts";

function createSession(id = "session"): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

function options(session: Session) {
	const models = {
		streamSimple: () => {
			throw new Error("stream not used in this test");
		},
	} as unknown as Models;
	const model = {
		id: "test",
		name: "test",
		api: "openai-responses",
		provider: "test",
		baseUrl: "",
		reasoning: false,
		input: [],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1024,
		maxTokens: 256,
	} as unknown as Model<Api>;
	return { session, models, model };
}

function runtimeOptions(session: Session) {
	const { model } = options(session);
	const models = {
		streamSimple: () => {
			const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(event) => event.type === "done" || event.type === "error",
				(event) => {
					if (event.type === "done") return event.message;
					if (event.type === "error") return event.error;
					throw new Error("Unexpected stream event");
				},
			);
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						api: "openai-responses",
						provider: "test",
						model: "test",
						usage,
						stopReason: "stop",
						timestamp: Date.now(),
					},
				}),
			);
			return stream;
		},
		completeSimple: async () =>
			({
				role: "assistant",
				content: [{ type: "text", text: "summary" }],
				api: "openai-responses",
				provider: "test",
				model: "test",
				usage,
				stopReason: "stop",
				timestamp: Date.now(),
			}) satisfies AssistantMessage,
	} as unknown as Models;
	return { session, models, model };
}

function operationStarted(id: string): NewRecord<OperationStartedRecord> {
	return {
		type: "operation_started",
		id,
		lane: "main",
		sourceLeafId: null,
		intent: { kind: "run", originalPrompt: [], initialMessages: [] },
	};
}

const usage: Usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("AgentHarness runtime", () => {
	it("persists a prompt run and closes its operation", async () => {
		const session = createSession("runtime");
		const harness = (await AgentHarness.create(runtimeOptions(session))).harness;
		const result = await harness.prompt("hello");
		expect(result.ok).toBe(true);
		expect((await session.findEntries({ order: "oldestFirst" })).map((entry) => entry.type)).toEqual([
			"message",
			"message",
		]);
		expect(await session.findOpenOperations("main")).toEqual([]);
		const compacted = await harness.compact();
		expect(compacted).toMatchObject({ ok: true, value: { kind: "completed" } });
		expect((await session.findEntries({ order: "oldestFirst" })).at(-1)?.type).toBe("compaction");
	});

	it("opens clean sessions and exposes suspended operations for recovery", async () => {
		const clean = await AgentHarness.create(options(createSession()));
		expect(clean.suspended).toEqual([]);
		expect(clean.harness.name).toBe("main");
		expect(await clean.harness.getLeafId()).toBeNull();

		const recorded = createSession("recorded");
		await recorded.appendRecord(operationStarted("run"));
		const restored = await AgentHarness.create(options(recorded));
		expect(restored.suspended).toMatchObject([{ id: "run", kind: "run", reason: "crash" }]);
		expect((await restored.harness.watch()).snapshot.operation).toMatchObject({ id: "run", status: "suspended" });
	});

	it("supports queues, state observation, lanes, and usage records", async () => {
		const harness = (await AgentHarness.create(options(createSession()))).harness;
		const queued = await harness.nextRun("next");
		expect(queued.ok).toBe(true);
		expect(await harness.peekAction()).toEqual({ kind: "commit_follow_up" });
		const watch = await harness.watch();
		expect(watch.snapshot.queues.nextRun).toHaveLength(1);
		const created = await harness.createLane("thread", null);
		expect(created.ok).toBe(true);
		expect((await harness.lanes()).map((lane) => lane.name)).toEqual(["main", "thread"]);
		await expect(harness.recordUsage(usage)).resolves.toMatchObject({ ok: true });
		await expect(harness.cancelQueued(queued.ok ? queued.value.entryId : "missing")).resolves.toMatchObject({
			ok: true,
		});
	});

	it("keeps configuration defensive and returns structured closed errors", async () => {
		const harness = (await AgentHarness.create(options(createSession()))).harness;
		const activeTools = ["one"];
		await harness.setActiveTools(activeTools);
		activeTools.push("mutated");
		expect(await harness.getActiveTools()).toEqual(["one"]);
		const tool = { name: "tool", label: "Tool" } as HarnessTool;
		await harness.setTools([tool]);
		expect((await harness.getTools()).map((item) => item.name)).toEqual(["tool"]);
		const resources: Resources = {
			skills: [{ name: "skill", description: "desc", content: "body", filePath: "/tmp/SKILL.md" }],
			promptTemplates: [{ name: "template", content: "body" }],
		};
		await harness.setResources(resources);
		resources.skills?.push({ name: "mutated", description: "desc", content: "body", filePath: "/tmp/OTHER.md" });
		expect((await harness.getResources()).skills?.map((skill) => skill.name)).toEqual(["skill"]);
		await harness.close();
		await expect(harness.prompt("hello")).resolves.toMatchObject({ ok: false, error: { _tag: "Closed" } });
		await expect(harness.waitForIdle()).rejects.toThrow("closed");
	});
});
