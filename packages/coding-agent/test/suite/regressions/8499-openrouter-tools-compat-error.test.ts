import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #8499 openrouter stream error surfacing", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("surfaces error when stream terminates with abnormal native finish reason", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "Provider native_finish_reason: network_error",
			}),
		]);

		await harness.session.prompt("test prompt");

		const assistantMessages = harness.session.messages.filter((m): m is AssistantMessage => m.role === "assistant");
		const lastAssistant = assistantMessages[assistantMessages.length - 1];
		expect(lastAssistant).toBeDefined();
		expect(lastAssistant.stopReason).toBe("error");
		expect(lastAssistant.errorMessage).toBe("Provider native_finish_reason: network_error");
	});

	it("preserves partial content when stream terminates with error", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Partial text before abort", {
				stopReason: "error",
				errorMessage: "Provider native_finish_reason: network_error",
			}),
		]);

		await harness.session.prompt("test prompt");

		const assistantMessages = harness.session.messages.filter((m): m is AssistantMessage => m.role === "assistant");
		const lastAssistant = assistantMessages[assistantMessages.length - 1];
		expect(lastAssistant).toBeDefined();
		expect(lastAssistant.stopReason).toBe("error");
		expect(lastAssistant.errorMessage).toBe("Provider native_finish_reason: network_error");
		expect(lastAssistant.content).toEqual([{ type: "text", text: "Partial text before abort" }]);
	});
});
