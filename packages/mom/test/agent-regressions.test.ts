import { describe, expect, it, vi } from "vitest";

import {
	enqueueAssistantProgressMessages,
	refreshSessionBaseSystemPrompt,
	refreshSessionBaseSystemPromptForRun,
	shortCircuitHandledPreflight,
} from "../src/agent-internals.js";
import {
	MAIN_OVERFLOW_NOTE,
	MAX_MAIN_MESSAGE_LENGTH,
	MAX_THREAD_MESSAGE_LENGTH,
	publishSplitFinalSlackReply,
} from "../src/slack-message-utils.js";

describe("mom agent regressions", () => {
	it("refreshes the canonical base prompt used for extension-enabled turns", () => {
		const session = {
			_baseSystemPrompt: "stale prompt",
			_rebuildSystemPrompt: vi.fn().mockReturnValue("fresh canonical prompt"),
			getActiveToolNames: vi.fn().mockReturnValue(["bash", "read"]),
			agent: {
				state: {
					systemPrompt: "stale prompt",
				},
			},
		} as any;

		refreshSessionBaseSystemPrompt(session);

		expect(session._rebuildSystemPrompt).toHaveBeenCalledWith(["bash", "read"]);
		expect(session._baseSystemPrompt).toBe("fresh canonical prompt");
		expect(session.agent.state.systemPrompt).toBe("fresh canonical prompt");
	});

	it("returns a fatal initialization result when the AgentSession seam drifts", () => {
		expect(refreshSessionBaseSystemPromptForRun({})).toEqual({
			stopReason: "error",
			errorMessage: "Unsupported @mariozechner/pi-coding-agent AgentSession shape for mom system-prompt refresh",
			fatalInitializationError: true,
		});
	});

	it("publishes oversized final replies with a continued-in-thread main message and thread overflow", async () => {
		const text = "a".repeat(MAX_MAIN_MESSAGE_LENGTH + MAX_THREAD_MESSAGE_LENGTH + 123);
		const mainMessages: string[] = [];
		const threadMessages: string[] = [];

		const result = await publishSplitFinalSlackReply({
			text,
			updateMainMessage: async (mainText) => {
				mainMessages.push(mainText);
			},
			postInThread: async (threadText) => {
				threadMessages.push(threadText);
			},
		});

		expect(result.mainText.endsWith(MAIN_OVERFLOW_NOTE)).toBe(true);
		expect(mainMessages).toEqual([result.mainText]);
		expect(threadMessages.length).toBe(2);
		expect(threadMessages.every((part) => part.length <= MAX_THREAD_MESSAGE_LENGTH)).toBe(true);
		expect(threadMessages.join("")).toBe(text.slice(MAX_MAIN_MESSAGE_LENGTH - MAIN_OVERFLOW_NOTE.length));
	});

	it("queues assistant thinking and text progress in the main message only", async () => {
		const mainMessages: string[] = [];
		const queueTasks: Array<Promise<void>> = [];
		const respondSpy = vi.fn(async (text: string) => {
			mainMessages.push(text);
		});
		const respondInThreadSpy = vi.fn(async () => {});
		const clearThinkingTimer = vi.fn();

		enqueueAssistantProgressMessages({
			content: [
				{ type: "thinking", thinking: "intermediate thought" },
				{ type: "text", text: "partial answer" },
			],
			hideThinkingBlock: false,
			clearThinkingTimer,
			queue: {
				enqueue(fn) {
					queueTasks.push(fn());
				},
			},
			publisher: {
				respond: respondSpy,
				respondInThread: respondInThreadSpy,
			},
		});
		await Promise.all(queueTasks);

		expect(mainMessages).toEqual(["_intermediate thought_", "partial answer"]);
		expect(clearThinkingTimer).toHaveBeenCalledTimes(2);
		expect(respondInThreadSpy).not.toHaveBeenCalled();
	});

	it("hides assistant thinking while still queuing assistant text progress in the main message", async () => {
		const mainMessages: string[] = [];
		const queueTasks: Array<Promise<void>> = [];
		const respondInThreadSpy = vi.fn(async () => {});

		enqueueAssistantProgressMessages({
			content: [
				{ type: "thinking", thinking: "hidden thought" },
				{ type: "text", text: "visible partial answer" },
			],
			hideThinkingBlock: true,
			clearThinkingTimer: vi.fn(),
			queue: {
				enqueue(fn) {
					queueTasks.push(fn());
				},
			},
			publisher: {
				respond: vi.fn(async (text: string) => {
					mainMessages.push(text);
				}),
				respondInThread: respondInThreadSpy,
			},
		});
		await Promise.all(queueTasks);

		expect(mainMessages).toEqual(["visible partial answer"]);
		expect(respondInThreadSpy).not.toHaveBeenCalled();
	});

	it("short-circuits handled input by flushing side effects and returning handled immediately", async () => {
		const flushPendingSlackEffectsSpy = vi.fn(async () => {});
		const flushQueueSpy = vi.fn(async () => {});

		const result = await shortCircuitHandledPreflight(
			{ action: "handled" },
			flushPendingSlackEffectsSpy,
			flushQueueSpy,
		);

		expect(result).toEqual({ stopReason: "handled" });
		expect(flushPendingSlackEffectsSpy).toHaveBeenCalledTimes(1);
		expect(flushQueueSpy).toHaveBeenCalledTimes(1);
	});

	it("does not short-circuit non-handled preflight results", async () => {
		const flushPendingSlackEffectsSpy = vi.fn(async () => {});
		const flushQueueSpy = vi.fn(async () => {});

		await expect(
			shortCircuitHandledPreflight({ action: "continue" }, flushPendingSlackEffectsSpy, flushQueueSpy),
		).resolves.toBeUndefined();
		expect(flushPendingSlackEffectsSpy).not.toHaveBeenCalled();
		expect(flushQueueSpy).not.toHaveBeenCalled();
	});
});
