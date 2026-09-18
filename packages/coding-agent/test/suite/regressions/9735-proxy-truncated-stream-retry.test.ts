import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

// A stream that ends before its terminal event is one condition, and pi already
// retries it when its own code reports it ("OpenAI Responses stream ended before
// a terminal response event"). Put an OpenAI-compatible proxy in front of the
// same upstream and the identical physical fault arrives worded differently, so
// the classifier must recognise the condition rather than each vendor's sentence.
describe("issue #9735 proxy-reported truncated stream retry", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	const truncatedStreamMessages = [
		// CLIProxyAPI, surfaced through LiteLLM.
		"litellm.APIError: stream error: stream disconnected before completion: stream closed before response.completed",
		// pi's own OpenAI Responses check, which already retried before this fix.
		"OpenAI Responses stream ended before a terminal response event",
		// Anthropic SDK (#4433), which already retried before this fix.
		"Anthropic stream ended before message_stop",
	];

	for (const errorMessage of truncatedStreamMessages) {
		it(`retries a stream cut before its terminal event: ${errorMessage.slice(0, 48)}...`, async () => {
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("recovered after the stream was cut"),
			]);

			await harness.session.prompt("test");

			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.eventsOfType("auto_retry_start").map((event) => event.errorMessage)).toEqual([errorMessage]);
			expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
			expect(getAssistantTexts(harness)).toContain("recovered after the stream was cut");
		});
	}
});
