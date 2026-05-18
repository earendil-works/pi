import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

describe("issue #4276 ctx.abort during tool_call", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("stops the current tool batch without appending an extra aborted assistant turn or consuming queued follow-up", async () => {
		const observedToolCallIds: string[] = [];

		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params, signal) => {
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return {
					content: [{ type: "text", text }],
					details: { text },
				};
			},
		};

		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event, ctx) => {
						observedToolCallIds.push(event.toolCallId);
						if (event.toolCallId === "tool-1") {
							pi.sendUserMessage("queued follow-up", { deliverAs: "followUp" });
							ctx.abort();
						}
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { text: "first" }, { id: "tool-1" }),
					fauxToolCall("echo", { text: "second" }, { id: "tool-2" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("should not run"),
		]);

		await harness.session.prompt("start");

		const assistantMessages = harness.session.messages.filter(
			(message): message is Extract<(typeof harness.session.messages)[number], { role: "assistant" }> =>
				message.role === "assistant",
		);
		const toolExecutionStartIds = harness.events.flatMap((event) => {
			if (event.type !== "tool_execution_start") {
				return [];
			}
			return [event.toolCallId];
		});
		const toolExecutionEndIds = harness.events.flatMap((event) => {
			if (event.type !== "tool_execution_end") {
				return [];
			}
			return [event.toolCallId];
		});
		const toolResults = harness.session.messages.filter(
			(message): message is Extract<(typeof harness.session.messages)[number], { role: "toolResult" }> =>
				message.role === "toolResult",
		);

		expect(observedToolCallIds).toEqual(["tool-1"]);
		expect(toolExecutionStartIds).toEqual(["tool-1"]);
		expect(toolExecutionEndIds).toEqual(["tool-1"]);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(assistantMessages.map((message) => message.stopReason)).toEqual(["toolUse"]);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]?.isError).toBe(true);
		expect(harness.session.pendingMessageCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("still emits tool_result hooks for aborted tool results", async () => {
		const observedToolCallIds: string[] = [];
		const observedToolResultIds: string[] = [];

		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params, signal) => {
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return {
					content: [{ type: "text", text }],
					details: { text },
				};
			},
		};

		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async (event, ctx) => {
						observedToolCallIds.push(event.toolCallId);
						if (event.toolCallId === "tool-1") {
							ctx.abort();
						}
					});
					pi.on("tool_result", async (event) => {
						observedToolResultIds.push(event.toolCallId);
						expect(event.isError).toBe(true);
						expect(event.content).toEqual([{ type: "text", text: "Tool execution was aborted" }]);
						return {
							content: [{ type: "text", text: "patched aborted result" }],
							details: { patched: true },
						};
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { text: "first" }, { id: "tool-1" }),
					fauxToolCall("echo", { text: "second" }, { id: "tool-2" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("should not run"),
		]);

		await harness.session.prompt("start");

		const toolResults = harness.session.messages.filter(
			(message): message is Extract<(typeof harness.session.messages)[number], { role: "toolResult" }> =>
				message.role === "toolResult",
		);

		expect(observedToolCallIds).toEqual(["tool-1"]);
		expect(observedToolResultIds).toEqual(["tool-1"]);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({
			content: [{ type: "text", text: "patched aborted result" }],
			details: { patched: true },
			isError: true,
		});
	});
});
