import { fauxAssistantMessage, fauxThinking, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

const errorMessage =
	"Codex error: Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.";

// Regression for #12124: recover the assistant request without replaying completed tools.
describe("issue #12124 websocket connection lifetime retry", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("omits the failed partial response and keeps completed tool results for the retry", async () => {
		let toolRuns = 0;
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
			tools: [
				{
					name: "record",
					label: "Record",
					description: "Record one operation",
					parameters: Type.Object({}),
					execute: async () => {
						toolRuns++;
						return { content: [{ type: "text", text: "completed once" }], details: {} };
					},
				},
			],
		});
		harnesses.push(harness);
		let retryMessages: Message[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("record", {}, { id: "completed_call" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxThinking("unfinished thinking"), fauxToolCall("record", {}, { id: "failed_call" })],
				{ stopReason: "error", errorMessage },
			),
			(context) => {
				retryMessages = context.messages;
				return fauxAssistantMessage("recovered");
			},
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(3);
		expect(toolRuns).toBe(1);
		expect(retryMessages.some((message) => message.role === "assistant" && message.stopReason === "error")).toBe(
			false,
		);
		expect(
			retryMessages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
		).toEqual(["completed_call"]);
		expect(harness.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, errorMessage }]);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
		expect(getAssistantTexts(harness).at(-1)).toBe("recovered");
	});

	it.each([
		{ enabled: false, maxRetries: 2, baseDelayMs: 0 },
		{ enabled: true, maxRetries: 0, baseDelayMs: 0 },
	])("honors a disabled or zero retry budget: %j", async (retry) => {
		const harness = await createHarness({ settings: { retry } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
	});

	it("stops after the configured number of retries", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(2);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([
			{ success: false, attempt: 2, finalError: errorMessage },
		]);
	});

	it("cancels the backoff without making another request", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage })]);

		const prompt = harness.session.prompt("test");
		await vi.waitFor(() => expect(harness.session.isRetrying).toBe(true));
		harness.session.abortRetry();
		await prompt;

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, finalError: "Retry cancelled" }]);
	});

	it("does not retry an aborted response with connection-limit wording", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "aborted", errorMessage })]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
	});
});
