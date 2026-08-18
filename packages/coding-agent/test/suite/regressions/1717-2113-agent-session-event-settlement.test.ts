import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function createEchoTool(): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, params) => {
			const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
			return { content: [{ type: "text", text }], details: { text } };
		},
	};
}

describe("regressions #1717/#2113: agent session event settlement", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps persisted assistant/toolResult message order when extension message_end handlers yield", async () => {
		const harness = await createHarness({
			tools: [createEchoTool()],
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role === "assistant") {
							await new Promise((resolve) => setTimeout(resolve, 20));
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "one" }), fauxToolCall("echo", { text: "two" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run tools");

		const branchMessages = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
		expect(branchMessages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"toolResult",
			"assistant",
		]);
		const firstToolResultIndex = branchMessages.findIndex((message) => message.role === "toolResult");
		expect(firstToolResultIndex).toBeGreaterThan(0);
		expect(branchMessages[firstToolResultIndex - 1]?.role).toBe("assistant");
	});

	it("runs tool_call handlers after the assistant tool-use message is settled in the session", async () => {
		let harness: Harness;
		const branchRolesAtToolCall: string[][] = [];
		harness = await createHarness({
			tools: [createEchoTool()],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", () => {
						branchRolesAtToolCall.push(
							harness.sessionManager
								.getBranch()
								.filter((entry) => entry.type === "message")
								.map((entry) => entry.message.role),
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run tool");

		expect(branchRolesAtToolCall).toEqual([["user", "assistant"]]);
	});
});
