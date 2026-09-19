import { setImmediate } from "node:timers/promises";
import { type AuthResult, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionCompactFailedEvent } from "../../../src/core/extensions/index.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

// Regression coverage for #9777: cancel the compaction attempt, not the enclosing prompt run.
describe("auto-compaction authentication attempt", () => {
	const harnesses: Harness[] = [];
	const authResult: AuthResult = { auth: { apiKey: "faux-key" }, source: "test" };

	afterEach(() => {
		vi.restoreAllMocks();
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function givenThresholdAttempt() {
		const failures: SessionCompactFailedEvent[] = [];
		const beforeCompact = vi.fn();
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 1000 }],
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 50 } },
			tools: [],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", beforeCompact);
					pi.on("session_compact_failed", (event) => {
						failures.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		harness.sessionManager.appendMessage({ role: "user", content: "old history", timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("old answer", { timestamp: Date.now() - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const answer = fauxAssistantMessage("completed answer");
		// Faux recalculates usage. Inject the threshold usage at message_end so only
		// the post-agent check compacts; the request itself stays below threshold.
		harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				getMessageText(event.message) === "completed answer"
			) {
				event.message.usage = {
					...event.message.usage,
					input: 99_500,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 99_500,
				};
			}
		});
		harness.setResponses([answer, fauxAssistantMessage("checkpoint summary")]);
		return { harness, failures, beforeCompact };
	}

	it("given noncooperative pending auth, abortCompaction ends the attempt before auth settles", async () => {
		const { harness, failures, beforeCompact } = await givenThresholdAttempt();
		let releaseAuth!: (result: AuthResult) => void;
		const pendingAuth = new Promise<AuthResult>((resolve) => {
			releaseAuth = resolve;
		});
		let authEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			authEntered = resolve;
		});
		let authSignal: AbortSignal | undefined;
		const getAuth = vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation((_model, options) => {
			authSignal = options?.signal;
			authEntered();
			return pendingAuth; // Deliberately does not listen to the signal.
		});
		const prompt = harness.session.prompt("next ".repeat(80));
		try {
			await entered;
			expect(harness.eventsOfType("agent_end")).toHaveLength(1);
			expect(harness.session.agent.hasQueuedMessages()).toBe(false);
			expect(harness.session.isCompacting).toBe(true);
			expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);

			// When cancelled, let promise continuations drain without releasing authentication.
			harness.session.abortCompaction();
			await setImmediate();

			// Then this attempt has terminated, without requiring provider cooperation.
			expect(authSignal?.aborted).toBe(true);
			expect(harness.eventsOfType("compaction_end")).toEqual([
				expect.objectContaining({ aborted: true, result: undefined, willRetry: false, errorMessage: undefined }),
			]);
			expect(failures).toEqual([expect.objectContaining({ aborted: true, errorMessage: undefined })]);
			expect(harness.session.isCompacting).toBe(false);
			expect(beforeCompact).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		} finally {
			releaseAuth(authResult);
			await prompt;
		}
		// Late auth cannot resurrect this attempt or persist a checkpoint.
		await setImmediate();
		expect(getAuth).toHaveBeenCalledOnce();
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("given a synchronous start listener abort, skips auth and summary", async () => {
		const { harness, failures, beforeCompact } = await givenThresholdAttempt();
		const getAuth = vi.spyOn(harness.session.modelRuntime, "getAuth").mockResolvedValue(authResult);
		let compactingAtStart = false;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") {
				compactingAtStart = harness.session.isCompacting;
				harness.session.abortCompaction();
			}
		});

		await harness.session.prompt("next ".repeat(80));

		expect(compactingAtStart).toBe(true);
		expect(getAuth).not.toHaveBeenCalled();
		expect(beforeCompact).not.toHaveBeenCalled();
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ aborted: true, result: undefined, willRetry: false, errorMessage: undefined }),
		]);
		expect(failures).toEqual([expect.objectContaining({ aborted: true, errorMessage: undefined })]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("given successful auth, generates and persists one summary after progress starts", async () => {
		const { harness, failures, beforeCompact } = await givenThresholdAttempt();
		let compactingAtAuth = false;
		let startsAtAuth = 0;
		let authSignal: AbortSignal | undefined;
		const getAuth = vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async (_model, options) => {
			compactingAtAuth = harness.session.isCompacting;
			startsAtAuth = harness.eventsOfType("compaction_start").length;
			authSignal = options?.signal;
			return authResult;
		});

		await harness.session.prompt("next ".repeat(80));

		expect(compactingAtAuth).toBe(true);
		expect(startsAtAuth).toBe(1);
		expect(authSignal).toBeInstanceOf(AbortSignal);
		expect(authSignal?.aborted).toBe(false);
		expect(getAuth).toHaveBeenCalledOnce();
		expect(beforeCompact).toHaveBeenCalledOnce();
		expect(beforeCompact.mock.calls[0][0].signal).toBe(authSignal);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "threshold", aborted: false, willRetry: false, result: expect.any(Object) }),
		]);
		expect(harness.eventsOfType("compaction_end")[0].result?.summary).toContain("checkpoint summary");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
		expect(failures).toHaveLength(0);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("given auth failure, emits a matched non-abort terminal and permits a later prompt", async () => {
		const { harness, failures, beforeCompact } = await givenThresholdAttempt();
		const getAuth = vi
			.spyOn(harness.session.modelRuntime, "getAuth")
			.mockRejectedValue(new Error("auth unavailable"));

		await harness.session.prompt("next ".repeat(80));

		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({
				reason: "threshold",
				aborted: false,
				willRetry: false,
				result: undefined,
				errorMessage: "Auto-compaction failed: auth unavailable",
			}),
		]);
		expect(failures).toEqual([
			expect.objectContaining({ aborted: false, errorMessage: "Auto-compaction failed: auth unavailable" }),
		]);
		expect(beforeCompact).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);

		getAuth.mockResolvedValue(authResult);
		harness.appendResponses([fauxAssistantMessage("later answer")]);
		await harness.session.prompt("retry after auth recovers");
		expect(harness.session.getLastAssistantText()).toBe("later answer");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(2);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(2);
		expect(harness.eventsOfType("compaction_end")[1].result?.summary).toContain("checkpoint summary");
	});

	it("given no eligible preparation, skips auth and does not announce an attempt", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const getAuth = vi.spyOn(harness.session.modelRuntime, "getAuth").mockResolvedValue(authResult);
		const session = harness.session as unknown as {
			_runAutoCompaction: (reason: "threshold", willRetry: boolean) => Promise<boolean>;
		};

		await expect(session._runAutoCompaction("threshold", false)).resolves.toBe(false);

		expect(getAuth).not.toHaveBeenCalled();
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.faux.state.callCount).toBe(0);
	});
});
