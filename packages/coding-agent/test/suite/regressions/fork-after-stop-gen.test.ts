import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	type StreamFunction,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";

function createAssistantMessage(text: string, stopReason: "stop" | "aborted" | "error"): AssistantMessage {
	return {
		role: "assistant",
		content: stopReason === "stop" ? [{ type: "text", text }] : [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage: stopReason === "stop" ? undefined : text,
		timestamp: Date.now(),
	} as AssistantMessage;
}

function stallingUntilAbort(): StreamFunction {
	return (_model, _context, options) => {
		const stream = createAssistantMessageEventStream();
		const signal = options?.signal;
		signal?.addEventListener(
			"abort",
			() => {
				stream.push({
					type: "error",
					reason: "aborted",
					error: createAssistantMessage("Request was aborted", "aborted"),
				} as AssistantMessageEvent);
				stream.end();
			},
			{ once: true },
		);
		return stream;
	};
}

describe("regression: stop gen then fork", () => {
	it("fork selector includes the just-sent user message after abort", async () => {
		const harness = await createHarness();
		const agent = harness.session as unknown as { agent: { streamFunction: StreamFunction } };
		agent.agent.streamFunction = stallingUntilAbort();

		try {
			const promptPromise = harness.session.prompt("first user message");
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(harness.session.isStreaming).toBe(true);

			await harness.session.abort();
			await promptPromise.catch(() => undefined);

			expect(harness.session.isStreaming).toBe(false);

			const userMessages = harness.session.getUserMessagesForForking();
			expect(userMessages.map((m) => m.text)).toContain("first user message");

			// NavigateTree is the same code path the fork selector uses internally
			// for "at" navigation. It must succeed for the just-aborted message.
			const result = await harness.session.navigateTree(userMessages[0]!.entryId, { summarize: false });
			expect(result.cancelled).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("abort during response leaves the user message available for the fork selector", async () => {
		const harness = await createHarness();
		// Seed an earlier user message so we have multiple user messages in the fork list.
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "earlier message" }],
			timestamp: Date.now(),
		});

		const agent = harness.session as unknown as { agent: { streamFunction: StreamFunction } };
		agent.agent.streamFunction = stallingUntilAbort();

		try {
			const promptPromise = harness.session.prompt("latest message");
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(harness.session.isStreaming).toBe(true);

			// Simulate the user pressing escape (stop gen) mid-response.
			await harness.session.abort();
			await promptPromise.catch(() => undefined);

			// After abort, both user messages are present, in order, and forkable.
			const userMessages = harness.session.getUserMessagesForForking();
			expect(userMessages.map((m) => m.text)).toEqual(["earlier message", "latest message"]);
		} finally {
			harness.cleanup();
		}
	});
});
