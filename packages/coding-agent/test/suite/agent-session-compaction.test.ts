import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "./harness.js";

type SessionWithCompactionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

const echoToolSchema = Type.Object({ text: Type.String() });

function createEchoTool(
	toolRuns: string[],
	options: { terminate?: boolean } = {},
): AgentTool<typeof echoToolSchema, { text: string }> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text",
		parameters: echoToolSchema,
		execute: async (_toolCallId, params) => {
			toolRuns.push(params.text);
			return {
				content: [{ type: "text" as const, text: params.text }],
				details: params,
				terminate: options.terminate,
			};
		},
	};
}

async function waitForCondition(condition: () => boolean, timeoutMs = 1000): Promise<void> {
	const startedAt = Date.now();
	while (!condition()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");

		expect(result.summary).toBe("summary from extension");
		expect(compactionEntries).toHaveLength(1);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("compacts between tool turns and resumes from the tool result", async () => {
		const toolRuns: string[] = [];
		const echoTool = createEchoTool(toolRuns);
		let releaseTurnEnd: () => void = () => {};
		let resolveTurnEndStarted: () => void = () => {};
		const turnEndGate = new Promise<void>((resolve) => {
			releaseTurnEnd = resolve;
		});
		const turnEndBlocked = new Promise<void>((resolve) => {
			resolveTurnEndStarted = resolve;
		});

		const harness = await createHarness({
			tools: [echoTool],
			settings: { compaction: { reserveTokens: 128000, keepRecentTokens: 10 } },
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", async () => {
						resolveTurnEndStarted();
						await turnEndGate;
					});
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "turn boundary compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		const model = harness.getModel();
		const oldUser = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "old seed history" }],
			timestamp: Date.now() - 10_000,
		};
		const oldAssistant: AssistantMessage = {
			...fauxAssistantMessage("old history that should be summarized away"),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(0),
			timestamp: Date.now() - 9000,
		};
		harness.sessionManager.appendMessage(oldUser);
		harness.sessionManager.appendMessage(oldAssistant);
		harness.session.agent.state.messages = [oldUser, oldAssistant];

		let compactionStarted = false;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") {
				compactionStarted = true;
			}
		});

		let rolesSeenByContinuation: string[] = [];
		let textSeenByContinuation = "";
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			(context) => {
				rolesSeenByContinuation = context.messages.map((message) => message.role);
				textSeenByContinuation = JSON.stringify(context.messages);
				return fauxAssistantMessage("continued after compaction");
			},
		]);

		const promptPromise = harness.session.prompt("run the tool");
		await turnEndBlocked;
		await Promise.resolve();
		expect(compactionStarted).toBe(false);
		releaseTurnEnd();
		await promptPromise;
		expect(harness.getPendingResponseCount()).toBe(1);

		await waitForCondition(() => harness.getPendingResponseCount() === 0);
		await harness.session.agent.waitForIdle();

		expect(toolRuns).toEqual(["hello"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("compaction_end").filter((event) => event.willRetry)).toHaveLength(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length).toBeGreaterThan(
			0,
		);
		expect(textSeenByContinuation).toContain("turn boundary compacted");
		expect(rolesSeenByContinuation.at(-1)).toBe("toolResult");
		expect(textSeenByContinuation).not.toContain("old seed history");
		expect(textSeenByContinuation).not.toContain("old history that should be summarized away");
		expect(getAssistantTexts(harness)).toContain("continued after compaction");
	});

	it("does not resume after turn-boundary compaction when a tool result terminates the batch", async () => {
		const toolRuns: string[] = [];
		const echoTool = createEchoTool(toolRuns, { terminate: true });
		const harness = await createHarness({
			tools: [echoTool],
			settings: { compaction: { reserveTokens: 128000, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "terminal tool compacted after stop",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const compactionEnded = new Promise<void>((resolve) => {
			harness.session.subscribe((event) => {
				if (event.type === "compaction_end") {
					resolve();
				}
			});
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "stop" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("should remain pending"),
		]);

		await harness.session.prompt("run terminal tool");
		await compactionEnded;

		expect(toolRuns).toEqual(["stop"]);
		expect(harness.eventsOfType("compaction_end").filter((event) => event.willRetry)).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getAssistantTexts(harness)).not.toContain("should remain pending");
	});

	it("does not compact below threshold between tool turns", async () => {
		const toolRuns: string[] = [];
		const echoTool = createEchoTool(toolRuns);
		const harness = await createHarness({
			tools: [echoTool],
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "small" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("continued without compaction"),
		]);

		await harness.session.prompt("run small tool");

		expect(toolRuns).toEqual(["small"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
		expect(getAssistantTexts(harness)).toContain("continued without compaction");
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkCompaction(overflowMessage);
		await sessionInternals._checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction").mockResolvedValue(false);

		await sessionInternals._checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = belowThresholdHarness.session as unknown as SessionWithCompactionInternals;
		const disabledInternals = disabledHarness.session as unknown as SessionWithCompactionInternals;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "_runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "_runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals._checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals._checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});
});
