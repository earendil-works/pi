import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Regression for #6647: compaction runs a single non-retried summarization call, so a
 * transient mid-stream socket death (`terminated`) failed the whole compaction.
 * Verifies that summarization now reuses `settings.retry` (bounded retries with
 * exponential backoff gated on isRetryableAssistantError), emits
 * `summarization_retry_*` events, and that aborts / non-retryable errors are not retried.
 */
describe("#6647 compaction retries transient summarization failures", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

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

	function seedCompactableSession(harness: Harness): void {
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		});
		const model = harness.getModel();
		const assistant: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "stop", timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(100),
		};
		assistant.content = [{ type: "text", text: "assistant response to compact" }];
		harness.sessionManager.appendMessage(assistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	}

	/** streamFn that responds with the given sequence of assistant messages across calls. */
	function useScriptedStreamFn(harness: Harness, script: AssistantMessage[]): () => number {
		let callCount = 0;
		const streamFunction: StreamFn = (model) => {
			const message = script[callCount] ?? script[script.length - 1]!;
			callCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					stream.push({
						type: "error",
						reason: message.stopReason,
						error: { ...message, api: model.api, provider: model.provider, model: model.id },
					});
				} else {
					stream.push({
						type: "done",
						reason: message.stopReason,
						message: { ...message, api: model.api, provider: model.provider, model: model.id },
					});
				}
			});
			return stream;
		};
		harness.session.agent.streamFunction = streamFunction;
		return () => callCount;
	}

	it("retries a transient `terminated` summarization error and compacts successfully", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } });

		const model = harness.getModel();
		const error = (errorMessage: string): AssistantMessage => ({
			...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			usage: createUsage(10),
		});
		const success: AssistantMessage = {
			...fauxAssistantMessage("recovered summary"),
			usage: createUsage(10),
		};
		const getCallCount = useScriptedStreamFn(harness, [error("terminated"), error("terminated"), success]);

		const result = await harness.session.compact();

		expect(result.summary).toContain("recovered summary");
		expect(getCallCount()).toBe(3); // 1 initial + 2 retries
		const starts = harness.eventsOfType("summarization_retry_scheduled");
		const ends = harness.eventsOfType("summarization_retry_finished");
		expect(starts).toHaveLength(2);
		expect(ends).toHaveLength(1);
		expect(starts[0]).toMatchObject({ attempt: 1, maxAttempts: 3, errorMessage: "terminated" });
		expect(starts[1]).toMatchObject({ attempt: 2, maxAttempts: 3 });
		expect(ends[0]).toMatchObject({ type: "summarization_retry_finished" });
		// model.* referenced to keep imports honest
		expect(model.id).toBeTruthy();
	});

	it("does not retry a non-retryable error (insufficient_quota)", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } });

		const error: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
			usage: createUsage(10),
		};
		const getCallCount = useScriptedStreamFn(harness, [error]);

		await expect(harness.session.compact()).rejects.toThrow("insufficient_quota");
		expect(getCallCount()).toBe(1);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(0);
	});

	it("does not retry when retry is disabled", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: false, maxRetries: 3, baseDelayMs: 0 } });

		const error: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
			usage: createUsage(10),
		};
		const getCallCount = useScriptedStreamFn(harness, [error]);

		await expect(harness.session.compact()).rejects.toThrow("terminated");
		expect(getCallCount()).toBe(1);
		expect(harness.eventsOfType("summarization_retry_scheduled")).toHaveLength(0);
	});

	it("stops retrying after maxRetries and reports failure", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } });

		const error: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
			usage: createUsage(10),
		};
		const getCallCount = useScriptedStreamFn(harness, [error, error, error]);

		await expect(harness.session.compact()).rejects.toThrow("terminated");
		expect(getCallCount()).toBe(3); // 1 initial + 2 retries
		const starts = harness.eventsOfType("summarization_retry_scheduled");
		const ends = harness.eventsOfType("summarization_retry_finished");
		expect(starts).toHaveLength(2);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({ type: "summarization_retry_finished" });
	});

	it("aborts an in-flight retry backoff via abortCompaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 5, baseDelayMs: 30_000 } });

		const error: AssistantMessage = {
			...fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
			usage: createUsage(10),
		};
		useScriptedStreamFn(harness, [error, error, error]);

		const compactPromise = harness.session.compact();
		// Let the first error resolve and the retry backoff sleep start.
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		// The aborted retry backoff is normalized to an aborted assistant message,
		// which compaction classifies as aborted.
		await expect(compactPromise).rejects.toThrow();
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({ aborted: true });
	});
});
