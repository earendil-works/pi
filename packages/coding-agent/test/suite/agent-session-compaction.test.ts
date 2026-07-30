import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

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
					pi.on("session_before_compact", async (event) => {
						if (!event.preparationAvailable) return { action: "cancel" };
						return {
							compaction: {
								summary: "summary from extension",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								usage: summaryUsage,
								details: { source: "extension" },
							},
						};
					});
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

	it("runs a terminal manual compaction handler before summary auth", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({
						action: "cancel",
						errorMessage: "Native summaries are disabled; use the reversible context projection",
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		await expect(harness.session.compact()).rejects.toThrow("Native summaries are disabled");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting compactable context without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);

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

	it("disables every native or extension-provided compaction checkpoint while preserving handled pressure", async () => {
		const nativeHarness = await createHarness({
			withConfiguredAuth: false,
			settings: {
				compaction: { keepRecentTokens: 1 },
				summaryCheckpoints: { enabled: false },
			},
		});
		harnesses.push(nativeHarness);
		seedCompactableSession(nativeHarness);
		const nativeInternals = nativeHarness.session as unknown as SessionWithCompactionInternals;
		await expect(nativeInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);
		await expect(nativeHarness.session.compact()).rejects.toThrow("Summary checkpoints are disabled");
		expect(nativeHarness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);

		const extensionHarness = await createHarness({
			withConfiguredAuth: false,
			settings: {
				compaction: { keepRecentTokens: 1 },
				summaryCheckpoints: { enabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						if (!event.preparationAvailable) return { action: "cancel" };
						return {
							compaction: {
								summary: "forbidden extension checkpoint",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(extensionHarness);
		seedCompactableSession(extensionHarness);
		const extensionInternals = extensionHarness.session as unknown as SessionWithCompactionInternals;
		await expect(extensionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);
		expect(extensionHarness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(
			0,
		);

		const handledHarness = await createHarness({
			withConfiguredAuth: false,
			settings: {
				compaction: { keepRecentTokens: 1 },
				summaryCheckpoints: { enabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ action: "handled", retry: false }));
				},
			],
		});
		harnesses.push(handledHarness);
		seedCompactableSession(handledHarness);
		const handledInternals = handledHarness.session as unknown as SessionWithCompactionInternals;
		await expect(handledInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);
		expect(handledHarness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			handledByExtension: true,
			aborted: false,
		});
	});

	it("emits automatic pressure to extensions even when no native checkpoint cut exists", async () => {
		let observed: { available: boolean; preparation: unknown; tokensBefore: number } | undefined;
		const harness = await createHarness({
			settings: { summaryCheckpoints: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						observed = {
							available: event.preparationAvailable,
							preparation: event.preparation,
							tokensBefore: event.tokensBefore,
						};
						return { action: "cancel", errorMessage: "No safe lossless projection" };
					});
				},
			],
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("overflow", true)).resolves.toBe(false);
		expect(observed).toEqual({ available: false, preparation: undefined, tokensBefore: 0 });
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			errorMessage: "No safe lossless projection",
			willRetry: false,
		});
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

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						if (!event.preparationAvailable) return { action: "cancel" };
						return {
							compaction: {
								summary: "auto compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
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

	it("lets an extension handle overflow and retry without a compaction checkpoint or summary auth", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) =>
						event.reason === "overflow" && event.willRetry ? { action: "handled", retry: true } : undefined,
					);
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("overflow", true)).resolves.toBe(true);

		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
			handledByExtension: true,
			result: undefined,
		});
	});

	it("handles a completed over-window response without retry or checkpoint", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) =>
						event.reason === "overflow" && !event.willRetry ? { action: "handled", retry: false } : undefined,
					);
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("overflow", false)).resolves.toBe(false);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
			handledByExtension: true,
		});
	});

	it("treats handled compaction as terminal across extension handlers", async () => {
		let laterCalls = 0;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ action: "handled", retry: true }));
				},
				(pi) => {
					pi.on("session_before_compact", async () => {
						laterCalls++;
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("overflow", true)).resolves.toBe(true);
		expect(laterCalls).toBe(0);
	});

	it("does not dispatch mutable globals or action coercion at the extension result boundary", async () => {
		let result: object;
		let descriptorCalls = 0;
		let arrayCalls = 0;
		let coercions = 0;
		const unknownAction = {
			toString: () => {
				coercions++;
				return "handled";
			},
		};
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						result = { action: unknownAction };
						return result as never;
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const originalDescriptor = Object.getOwnPropertyDescriptor;
		const originalArray = Array.isArray;
		Object.getOwnPropertyDescriptor = ((value: object, key: PropertyKey) => {
			if (value === result) descriptorCalls++;
			return originalDescriptor(value, key);
		}) as typeof Object.getOwnPropertyDescriptor;
		Array.isArray = ((value: unknown) => {
			if (value === result) arrayCalls++;
			return originalArray(value);
		}) as typeof Array.isArray;
		try {
			await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);
		} finally {
			Object.getOwnPropertyDescriptor = originalDescriptor;
			Array.isArray = originalArray;
		}
		expect({ descriptorCalls, arrayCalls, coercions }).toEqual({
			descriptorCalls: 0,
			arrayCalls: 0,
			coercions: 0,
		});
	});

	it("honors synchronous abort and disposal from compaction_start before running handlers", async () => {
		for (const dispose of [false, true]) {
			let handlerCalls = 0;
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async () => {
							handlerCalls++;
							return { action: "handled", retry: true };
						});
					},
				],
			});
			harnesses.push(harness);
			seedCompactableSession(harness);
			const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "compaction_start") return;
				if (dispose) harness.session.dispose();
				else harness.session.abortCompaction();
			});

			await expect(sessionInternals._runAutoCompaction("overflow", true)).resolves.toBe(false);
			unsubscribe();
			expect(handlerCalls).toBe(0);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			if (!dispose) {
				expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
					aborted: true,
					willRetry: false,
				});
			}
		}
	});

	it("aborts an in-flight handled overflow before it can retry or checkpoint", async () => {
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						entered();
						await new Promise<void>((resolve) =>
							event.signal.addEventListener("abort", () => resolve(), { once: true }),
						);
						return { action: "handled", retry: true };
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		const recovery = sessionInternals._runAutoCompaction("overflow", true);
		await started;
		await harness.session.abort();
		await expect(recovery).resolves.toBe(false);

		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true, willRetry: false });
	});

	it("continues the same agent operation after extension-handled overflow", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) =>
						event.reason === "overflow" && event.willRetry ? { action: "handled", retry: true } : undefined,
					);
				},
			],
		});
		harnesses.push(harness);
		const rejected = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		harness.setResponses([fauxAssistantMessage("seed"), rejected, fauxAssistantMessage("recovered")]);
		let settled = 0;
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") settled++;
		});

		await harness.session.prompt("seed turn");
		settled = 0;
		await harness.session.prompt("overflow turn");

		expect(harness.faux.state.callCount).toBe(3);
		expect(settled).toBe(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(2);
		expect(harness.session.messages.some((message) => message === rejected)).toBe(false);
	});

	it("rejects handled retry outside interrupted overflow without falling through to native compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ action: "handled", retry: true }));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		await expect(sessionInternals._runAutoCompaction("threshold", false)).resolves.toBe(false);

		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain(
			"retry only an interrupted overflow recovery",
		);
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
		harness.session.agent.state.messages = [overflowMessage];
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

	it("stops overflow recovery when the rejected response is not the exact live tail", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [{ ...overflowMessage }];
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "_runAutoCompaction");

		await expect(sessionInternals._checkCompaction(overflowMessage)).resolves.toBe(false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
		expect(harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain("not the live context tail");
	});

	it("compacts successful overflow responses without retrying", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						if (!event.preparationAvailable) return { action: "cancel" };
						return {
							compaction: {
								summary: "successful overflow compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(1);
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
