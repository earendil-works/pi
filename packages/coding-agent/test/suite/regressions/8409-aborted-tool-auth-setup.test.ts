import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #8409 aborted tool auth setup", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("ends the turn as aborted when auth setup sees an already-aborted signal", async () => {
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
		const modelRuntime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) =>
			modelRuntime.streamSimple(model, context, options);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" })]);

		const prompt = harness.session.prompt("run the blocking tool");
		await toolStarted;
		await harness.session.abort();
		await prompt;

		const finalAssistant = harness.session.messages
			.slice()
			.reverse()
			.find((message) => message.role === "assistant");
		expect(finalAssistant?.role).toBe("assistant");
		if (finalAssistant?.role !== "assistant") throw new Error("Expected final assistant message");
		expect(finalAssistant.stopReason).toBe("aborted");
	});
});
