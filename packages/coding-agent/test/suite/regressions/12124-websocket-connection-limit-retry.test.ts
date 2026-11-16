import { fauxAssistantMessage, fauxThinking, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

const errorMessage =
	"Codex error: Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.";

// Regression for #12124: the limit can hit mid-stream after partial thinking, where the provider cannot reconnect.
describe("issue #12124 websocket connection lifetime retry", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("retries the turn without the failed partial response or re-running completed tools", async () => {
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
			fauxAssistantMessage([fauxThinking("unfinished thinking")], { stopReason: "error", errorMessage }),
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
		expect(harness.eventsOfType("auto_retry_start")).toMatchObject([{ attempt: 1, errorMessage }]);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: true, attempt: 1 }]);
		expect(getAssistantTexts(harness).at(-1)).toBe("recovered");
	});
});
