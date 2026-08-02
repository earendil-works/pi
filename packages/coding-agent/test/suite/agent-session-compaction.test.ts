import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { createHarness, getMessageText, getUserTexts, type Harness, type HarnessOptions } from "./harness.ts";

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

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFunction = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function createThresholdHarness(extensionFactories?: HarnessOptions["extensionFactories"]): Promise<Harness> {
	return createHarness({
		settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 99_000 } },
		models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 100 }],
		extensionFactories,
	});
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
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
		const summaryUsage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							usage: summaryUsage,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const statsBefore = harness.session.getSessionStats();

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const estimatedTokensAfter = harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);

		expect(result.summary).toBe("summary from extension");
		expect(result.usage).toEqual(summaryUsage);
		expect(result.estimatedTokensAfter).toBe(estimatedTokensAfter);
		expect(compactionEntries).toHaveLength(1);
		const compactionEntry = compactionEntries[0];
		if (compactionEntry?.type === "compaction") {
			expect(compactionEntry.usage).toEqual(summaryUsage);
		}
		const statsAfter = harness.session.getSessionStats();
		expect(statsAfter.tokens.input).toBe(statsBefore.tokens.input + summaryUsage.input);
		expect(statsAfter.tokens.output).toBe(statsBefore.tokens.output + summaryUsage.output);
		expect(statsAfter.tokens.cacheRead).toBe(statsBefore.tokens.cacheRead + summaryUsage.cacheRead);
		expect(statsAfter.tokens.cacheWrite).toBe(statsBefore.tokens.cacheWrite + summaryUsage.cacheWrite);
		expect(statsAfter.cost).toBe(statsBefore.cost + summaryUsage.cost.total);
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

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("manually compacts with provider-resolved bearer auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const model = harness.getModel();
		harness.session.modelRuntime.registerNativeProvider({
			id: model.provider,
			name: "Faux bearer provider",
			auth: {
				apiKey: {
					name: "Faux bearer token",
					resolve: async () => ({
						auth: { headers: { Authorization: "Bearer ambient-token" } },
						source: "ambient bearer token",
					}),
				},
			},
			getModels: () => harness.models,
			stream: () => createAssistantMessageEventStream(),
			streamSimple: () => createAssistantMessageEventStream(),
		});
		seedCompactableSession(harness);
		harness.setResponses([
			(_context, options) => {
				expect(options?.apiKey).toBeUndefined();
				expect(options?.headers).toEqual({ Authorization: "Bearer ambient-token" });
				return fauxAssistantMessage("summary with bearer auth");
			},
		]);

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary with bearer auth");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("persists usage from pi-generated manual compaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(result.usage).toEqual(createUsage(10));
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEntries[0]?.type === "compaction" ? compactionEntries[0].usage : undefined).toEqual(
			createUsage(10),
		);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await sessionInternals._runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThan(0);
		expect(getStreamCallCount()).toBe(1);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
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

	it("cancels auto-compaction while authentication is pending", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedCompactableSession(harness);
		const model = harness.getModel();
		const auth = await harness.session.modelRuntime.getAuth(model);
		let markAuthStarted = () => {};
		const authStarted = new Promise<void>((resolve) => {
			markAuthStarted = resolve;
		});
		let releaseAuth = () => {};
		const authReleased = new Promise<void>((resolve) => {
			releaseAuth = resolve;
		});
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async () => {
			markAuthStarted();
			await authReleased;
			return auth;
		});
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		const compaction = sessionInternals._runAutoCompaction("threshold", false);
		await authStarted;
		harness.session.abortCompaction();
		releaseAuth();

		await expect(compaction).resolves.toBe(false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(0);
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

		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(true);
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

	it("serializes prompts while authentication is pending", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const provider = harness.getModel().provider;
		const auth = await harness.session.modelRuntime.checkAuth(provider);
		let markAuthStarted = () => {};
		const authStarted = new Promise<void>((resolve) => {
			markAuthStarted = resolve;
		});
		let releaseAuth = () => {};
		const authReleased = new Promise<void>((resolve) => {
			releaseAuth = resolve;
		});
		vi.spyOn(harness.session.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
		const checkAuth = vi.spyOn(harness.session.modelRuntime, "checkAuth").mockImplementation(async () => {
			markAuthStarted();
			await authReleased;
			return auth;
		});
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);

		const firstPrompt = harness.session.prompt("first");
		await authStarted;
		const secondPrompt = harness.session.prompt("second", { streamingBehavior: "followUp" });
		releaseAuth();
		await Promise.all([firstPrompt, secondPrompt]);

		expect(checkAuth).toHaveBeenCalledTimes(1);
		expect(harness.faux.state.callCount).toBe(2);
		expect(getUserTexts(harness)).toEqual(["first", "second"]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it("does not start a prompt when authentication is aborted", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const provider = harness.getModel().provider;
		const auth = await harness.session.modelRuntime.checkAuth(provider);
		let markAuthStarted = () => {};
		const authStarted = new Promise<void>((resolve) => {
			markAuthStarted = resolve;
		});
		let releaseAuth = () => {};
		const authReleased = new Promise<void>((resolve) => {
			releaseAuth = resolve;
		});
		vi.spyOn(harness.session.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
		vi.spyOn(harness.session.modelRuntime, "checkAuth").mockImplementation(async () => {
			markAuthStarted();
			await authReleased;
			return auth;
		});

		const prompt = harness.session.prompt("hello");
		const promptResult = prompt.then(
			() => undefined,
			(error: unknown) => error,
		);
		await authStarted;
		const abortPromise = harness.session.abort();
		releaseAuth();
		await abortPromise;

		const error = await promptResult;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Request was aborted");
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.isIdle).toBe(true);
	});

	it("allows a waiting prompt to proceed after authentication fails", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const provider = harness.getModel().provider;
		const auth = await harness.session.modelRuntime.checkAuth(provider);
		let markAuthStarted = () => {};
		const authStarted = new Promise<void>((resolve) => {
			markAuthStarted = resolve;
		});
		let releaseAuth = () => {};
		const authReleased = new Promise<void>((resolve) => {
			releaseAuth = resolve;
		});
		let markSecondAuthStarted = () => {};
		const secondAuthStarted = new Promise<void>((resolve) => {
			markSecondAuthStarted = resolve;
		});
		let releaseSecondAuth = () => {};
		const secondAuthReleased = new Promise<void>((resolve) => {
			releaseSecondAuth = resolve;
		});
		vi.spyOn(harness.session.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
		const checkAuth = vi
			.spyOn(harness.session.modelRuntime, "checkAuth")
			.mockImplementationOnce(async () => {
				markAuthStarted();
				await authReleased;
				return undefined;
			})
			.mockImplementationOnce(async () => {
				markSecondAuthStarted();
				await secondAuthReleased;
				return auth;
			});
		harness.setResponses([fauxAssistantMessage("second answer")]);

		const firstPrompt = harness.session.prompt("first");
		const firstResult = firstPrompt.then(
			() => undefined,
			(error: unknown) => error,
		);
		await authStarted;
		const secondPrompt = harness.session.prompt("second", { streamingBehavior: "followUp" });
		let idleSettled = false;
		const idlePromise = harness.session.waitForIdle().then(() => {
			idleSettled = true;
		});
		releaseAuth();
		await secondAuthStarted;

		expect(idleSettled).toBe(false);
		releaseSecondAuth();
		const error = await firstResult;
		expect(error).toBeInstanceOf(Error);
		await Promise.all([secondPrompt, idlePromise]);
		expect(checkAuth).toHaveBeenCalledTimes(2);
		expect(harness.faux.state.callCount).toBe(1);
		expect(getUserTexts(harness)).toEqual(["second"]);
	});

	it("defers successful overflow compaction until the next prompt", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "successful overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer"), fauxAssistantMessage("continued answer")]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);

		await harness.session.prompt("continue");

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("defers threshold compaction until the next prompt while idle", async () => {
		const extensionEvents: string[] = [];
		const harness = await createThresholdHarness([
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					extensionEvents.push("session_before_compact");
					return {
						compaction: {
							summary: "threshold compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
				pi.on("before_agent_start", () => {
					extensionEvents.push("before_agent_start");
				});
			},
		]);
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer"), fauxAssistantMessage("continued answer")]);

		await harness.session.prompt("x".repeat(2_400));

		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);

		extensionEvents.length = 0;
		await harness.session.prompt("continue");

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
		});
		expect(extensionEvents).toEqual(["session_before_compact", "before_agent_start"]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("does not start a prompt when deferred pre-prompt compaction is aborted", async () => {
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		const harness = await createThresholdHarness([
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					markCompactionStarted();
					await new Promise<void>((resolve) => {
						if (event.signal.aborted) {
							resolve();
							return;
						}
						event.signal.addEventListener("abort", () => resolve(), { once: true });
					});
					return { cancel: true };
				});
			},
		]);
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await harness.session.prompt("x".repeat(2_400));
		const continuedPrompt = harness.session.prompt("continue");
		const promptResult = continuedPrompt.then(
			() => undefined,
			(error: unknown) => error,
		);
		await compactionStarted;

		await harness.session.abort();

		const error = await promptResult;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Request was aborted");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.isIdle).toBe(true);
	});

	it("preserves pending context when prompt preparation is aborted", async () => {
		let beforeStartCount = 0;
		let markBeforeStart = () => {};
		const beforeStart = new Promise<void>((resolve) => {
			markBeforeStart = resolve;
		});
		let releaseBeforeStart = () => {};
		const beforeStartReleased = new Promise<void>((resolve) => {
			releaseBeforeStart = resolve;
		});
		const harness = await createThresholdHarness([
			(pi) => {
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "prompt preparation compacted",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
				pi.on("before_agent_start", async () => {
					beforeStartCount++;
					if (beforeStartCount !== 2) return;
					markBeforeStart();
					await beforeStartReleased;
					return { systemPrompt: "stale aborted override" };
				});
			},
		]);
		harnesses.push(harness);
		const baseSystemPrompt = harness.session.systemPrompt;
		let sawPendingContext = false;
		harness.setResponses([
			fauxAssistantMessage("completed answer"),
			(context) => {
				sawPendingContext = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "carry this",
				);
				return fauxAssistantMessage("continued answer");
			},
		]);

		await harness.session.prompt("x".repeat(2_400));
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "carry this", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		const continuedPrompt = harness.session.prompt("continue");
		const promptResult = continuedPrompt.then(
			() => undefined,
			(error: unknown) => error,
		);
		await beforeStart;

		const abortPromise = harness.session.abort();
		releaseBeforeStart();
		await abortPromise;

		const error = await promptResult;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Request was aborted");
		expect(harness.session.systemPrompt).toBe(baseSystemPrompt);

		await harness.session.prompt("try again");

		expect(sawPendingContext).toBe(true);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("preserves next-turn context added during prompt preparation", async () => {
		let markBeforeStart = () => {};
		const beforeStart = new Promise<void>((resolve) => {
			markBeforeStart = resolve;
		});
		let releaseBeforeStart = () => {};
		const beforeStartReleased = new Promise<void>((resolve) => {
			releaseBeforeStart = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						markBeforeStart();
						await beforeStartReleased;
					});
				},
			],
		});
		harnesses.push(harness);
		let firstPromptSawPendingContext = false;
		let secondPromptSawPendingContext = false;
		harness.setResponses([
			(context) => {
				firstPromptSawPendingContext = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "carry this",
				);
				return fauxAssistantMessage("first answer");
			},
			(context) => {
				secondPromptSawPendingContext = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "carry this",
				);
				return fauxAssistantMessage("second answer");
			},
		]);

		const firstPrompt = harness.session.prompt("first");
		await beforeStart;
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "carry this", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		releaseBeforeStart();
		await firstPrompt;
		await harness.session.prompt("second");

		expect(firstPromptSawPendingContext).toBe(false);
		expect(secondPromptSawPendingContext).toBe(true);
	});

	it("queues input submitted while deferred pre-prompt compaction runs", async () => {
		let markCompactionStarted = () => {};
		const compactionStarted = new Promise<void>((resolve) => {
			markCompactionStarted = resolve;
		});
		let releaseCompaction = () => {};
		const compactionReleased = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});
		const harness = await createThresholdHarness([
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					markCompactionStarted();
					await compactionReleased;
					return {
						compaction: {
							summary: "deferred prompt compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
			},
		]);
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("completed answer"),
			fauxAssistantMessage("continued answer"),
			fauxAssistantMessage("queued answer"),
		]);

		await harness.session.prompt("x".repeat(2_400));
		const continuedPrompt = harness.session.prompt("continue");
		await compactionStarted;

		expect(harness.session.isStreaming).toBe(true);
		await harness.session.prompt("queued follow-up", { streamingBehavior: "followUp" });
		releaseCompaction();
		await continuedPrompt;

		expect(getUserTexts(harness)).toEqual(["continue", "queued follow-up"]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(2);
	});

	it("compacts before a queued continuation", async () => {
		let queuedFollowUp = false;
		const harness = await createThresholdHarness([
			(pi) => {
				pi.on("agent_end", () => {
					if (queuedFollowUp) return;
					queuedFollowUp = true;
					pi.sendUserMessage("queued follow-up", { deliverAs: "followUp" });
				});
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "queued continuation compacted",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
		]);
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer"), fauxAssistantMessage("follow-up answer")]);

		await harness.session.prompt("x".repeat(2_400));

		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("does not continue when a queued message is cleared during compaction", async () => {
		let activeSession: Harness["session"] | undefined;
		let queuedFollowUp = false;
		const harness = await createThresholdHarness([
			(pi) => {
				pi.on("agent_end", () => {
					if (queuedFollowUp) return;
					queuedFollowUp = true;
					pi.sendUserMessage("queued follow-up", { deliverAs: "followUp" });
				});
				pi.on("session_before_compact", async (event) => {
					activeSession?.clearQueue();
					return {
						compaction: {
							summary: "queue cleared during compaction",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
			},
		]);
		activeSession = harness.session;
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await harness.session.prompt("x".repeat(2_400));

		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
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
