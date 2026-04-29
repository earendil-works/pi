import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

describe("stale tool call recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("stops auto-retrying after two recovery attempts instead of looping forever", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage('<tool_calls><invoke name="echo"></invoke></tool_calls>', { stopReason: "stop" }),
			fauxAssistantMessage('<tool_calls><invoke name="echo"></invoke></tool_calls>', { stopReason: "stop" }),
			fauxAssistantMessage('<tool_calls><invoke name="echo"></invoke></tool_calls>', { stopReason: "stop" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("start");
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.isRetrying).toBe(false);
	});
});
