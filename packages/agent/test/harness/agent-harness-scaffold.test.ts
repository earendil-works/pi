import { createModels, type Usage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	AgentHarness,
	HarnessClosed,
	HarnessNotImplemented,
	type HarnessTool,
	type Resources,
} from "../../src/harness/agent-harness.ts";
import {
	InMemorySessionStorage,
	type NewRecord,
	type OperationStartedRecord,
	Session,
} from "../../src/harness/session/index.ts";
import type { AgentMessage } from "../../src/types.ts";

function createSession(id = "session"): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

function createHarness(session = createSession()): Promise<AgentHarness> {
	return AgentHarness.create({
		session,
		models: createModels(),
		model: getModel("google", "gemini-2.5-flash"),
	}).then(({ harness }) => harness);
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

const userMessage: AgentMessage = {
	role: "user",
	content: [{ type: "text", text: "hello" }],
	timestamp: 1,
};

const usage: Usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("AgentHarness v2 scaffold", () => {
	it("opens only record-free sessions before restore is implemented", async () => {
		const session = createSession();
		const { harness, suspended } = await AgentHarness.create({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
		});

		expect(suspended).toEqual([]);
		expect(harness.name).toBe("main");
		expect(harness.session).toBe(session);
		expect(await harness.getLeafId()).toBeNull();
		expect(await harness.session.getLeafId()).toBeNull();

		await expect(harness.close()).resolves.toBeUndefined();

		const recorded = createSession("recorded");
		await recorded.appendRecord(operationStarted("run"));
		await expect(
			AgentHarness.create({
				session: recorded,
				models: createModels(),
				model: getModel("google", "gemini-2.5-flash"),
			}),
		).rejects.toMatchObject({ name: "HarnessNotImplemented", operation: "create.restore" });
	});

	it("keeps scaffold-safe configuration as defensive copies", async () => {
		const harness = await createHarness();
		const model = getModel("anthropic", "claude-sonnet-4-5");
		await harness.setModel(model);
		expect(await harness.getModel()).toBe(model);

		await harness.setThinkingLevel("high");
		expect(await harness.getThinkingLevel()).toBe("high");

		const activeTools = ["one"];
		await harness.setActiveTools(activeTools);
		activeTools.push("mutated");
		expect(await harness.getActiveTools()).toEqual(["one"]);
		const readActiveTools = await harness.getActiveTools();
		readActiveTools.push("mutated");
		expect(await harness.getActiveTools()).toEqual(["one"]);

		const tool = { name: "tool", label: "Tool" } as HarnessTool;
		const tools = [tool];
		await harness.setTools(tools);
		tools.push({ name: "mutated", label: "Mutated" } as HarnessTool);
		expect((await harness.getTools()).map((item) => item.name)).toEqual(["tool"]);
		const readTools = await harness.getTools();
		readTools.push({ name: "mutated", label: "Mutated" } as HarnessTool);
		expect((await harness.getTools()).map((item) => item.name)).toEqual(["tool"]);

		const resources: Resources = {
			skills: [{ name: "skill", description: "desc", content: "body", filePath: "/tmp/SKILL.md" }],
			promptTemplates: [{ name: "template", content: "body" }],
		};
		await harness.setResources(resources);
		resources.skills?.push({ name: "mutated", description: "desc", content: "body", filePath: "/tmp/OTHER.md" });
		expect((await harness.getResources()).skills?.map((skill) => skill.name)).toEqual(["skill"]);
		const readResources = await harness.getResources();
		readResources.skills?.push({ name: "mutated", description: "desc", content: "body", filePath: "/tmp/OTHER.md" });
		expect((await harness.getResources()).skills?.map((skill) => skill.name)).toEqual(["skill"]);

		const streamOptions = { maxTokens: 10 };
		await harness.setStreamOptions(streamOptions);
		streamOptions.maxTokens = 20;
		expect(await harness.getStreamOptions()).toEqual({ maxTokens: 10 });
		const readStreamOptions = await harness.getStreamOptions();
		readStreamOptions.maxTokens = 30;
		expect(await harness.getStreamOptions()).toEqual({ maxTokens: 10 });

		const retryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 10 };
		await harness.setRetryPolicy(retryPolicy);
		retryPolicy.maxRetries = 99;
		expect(await harness.getRetryPolicy()).toEqual({ enabled: true, maxRetries: 2, baseDelayMs: 10 });

		const compactionSettings = { enabled: false, reserveTokens: 1, keepRecentTokens: 2 };
		await harness.setCompactionSettings(compactionSettings);
		compactionSettings.reserveTokens = 99;
		expect(await harness.getCompactionSettings()).toEqual({ enabled: false, reserveTokens: 1, keepRecentTokens: 2 });

		await harness.setSteeringMode("all");
		expect(await harness.getSteeringMode()).toBe("all");
		await harness.setFollowUpMode("all");
		expect(await harness.getFollowUpMode()).toBe("all");
	});

	it("rejects every unfinished public operation explicitly", async () => {
		const harness = await createHarness();
		let callbackCalled = false;
		const unfinished: [string, () => unknown | Promise<unknown>][] = [
			["prompt", () => harness.prompt("hello")],
			["skill", () => harness.skill("skill")],
			["promptFromTemplate", () => harness.promptFromTemplate("template")],
			["compact", () => harness.compact()],
			["navigateTree", () => harness.navigateTree(null)],
			["resume", () => harness.resume()],
			["abort", () => harness.abort()],
			["steer", () => harness.steer(userMessage)],
			["followUp", () => harness.followUp(userMessage)],
			["nextRun", () => harness.nextRun(userMessage)],
			["cancelQueued", () => harness.cancelQueued("queued")],
			["recordUsage", () => harness.recordUsage(usage)],
			["waitForIdle", () => harness.waitForIdle()],
			[
				"runWhenIdle",
				() =>
					harness.runWhenIdle(() => {
						callbackCalled = true;
					}),
			],
			["peekAction", () => harness.peekAction()],
			["executeAction", () => harness.executeAction()],
			["runToCompletion", () => harness.runToCompletion()],
			["watch", () => harness.watch()],
			["lane", () => harness.lane("main")],
			["createLane", () => harness.createLane("thread", null)],
			["lanes", () => harness.lanes()],
			["watchSession", () => harness.watchSession()],
		];

		for (const [operation, invoke] of unfinished) {
			await expect(Promise.resolve().then(invoke), operation).rejects.toMatchObject({
				name: "HarnessNotImplemented",
				operation,
			});
		}
		expect(callbackCalled).toBe(false);
		expect(() => harness.hooks.on("before_run", () => {})).toThrow(HarnessNotImplemented);
		expect(() => harness.events.on("event", () => {})).toThrow(HarnessNotImplemented);
	});

	it("reports HarnessClosed for unfinished operations after close", async () => {
		const harness = await createHarness();
		await harness.close();

		await expect(harness.prompt("hello")).rejects.toBeInstanceOf(HarnessClosed);
		await expect(harness.waitForIdle()).rejects.toBeInstanceOf(HarnessClosed);
		expect(() => harness.hooks.on("before_run", () => {})).toThrow(HarnessClosed);
		expect(() => harness.events.on("event", () => {})).toThrow(HarnessClosed);
	});
});
