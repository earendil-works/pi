import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Regression test for https://github.com/earendil-works/pi/issues/12119
 *
 * /copy uses getLastAssistantText(), which took the last assistant message and skipped only aborted
 * messages with no content. After Esc during a tool call the last messages are a tool-call-only message
 * and an empty one; after a provider error it is an empty error message. Neither has text, so /copy said
 * "No agent messages to copy yet." while the previous answer was on screen.
 */
describe("issue #12119 /copy after an aborted or failed turn", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("returns the previous answer after Esc during a tool call", async () => {
		let markToolStarted = () => {};
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const blockingTool: AgentTool = {
			name: "block",
			label: "Block",
			description: "Blocks until aborted",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, signal) => {
				markToolStarted();
				await new Promise<void>((resolve) => {
					if (signal?.aborted) resolve();
					else signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return { content: [{ type: "text", text: "tool aborted" }], details: {} };
			},
		};
		harness = await createHarness({ tools: [blockingTool] });
		harness.setResponses([
			fauxAssistantMessage("Here is the answer."),
			fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
		]);

		await harness.session.prompt("first question");
		const run = harness.session.prompt("run the blocking tool");
		await toolStarted;
		await harness.session.abort();
		await run;

		expect(harness.session.getLastAssistantText()).toBe("Here is the answer.");
	});

	it("returns the previous answer after a provider error", async () => {
		harness = await createHarness();
		harness.setResponses([
			fauxAssistantMessage("Here is the answer."),
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "400 invalid_request_error" }),
		]);

		await harness.session.prompt("first question");
		await harness.session.prompt("second question");

		expect(harness.session.getLastAssistantText()).toBe("Here is the answer.");
	});

	it("keeps a reply that ended normally without text as the last reply", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("Here is the answer."), fauxAssistantMessage([])]);

		await harness.session.prompt("first question");
		await harness.session.prompt("second question");

		expect(harness.session.getLastAssistantText()).toBeUndefined();
	});
});
