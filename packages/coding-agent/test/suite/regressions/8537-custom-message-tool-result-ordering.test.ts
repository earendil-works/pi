import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

function roles(messages: AgentMessage[]): string[] {
	return messages.map((message) => message.role);
}

describe("#8537 custom messages injected during tool execution", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("appends the message after the turn's tool results instead of between call and result", async () => {
		let notify: (() => Promise<void>) | undefined;
		const slowTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for a background task",
			parameters: Type.Object({}),
			execute: async () => {
				// A background task (e.g. a subagent reply) notifies the session while the
				// tool is still running.
				await notify?.();
				return { content: [{ type: "text", text: "tool done" }], details: {} };
			},
		};

		const harness = await createHarness({ tools: [slowTool] });
		harnesses.push(harness);
		notify = () =>
			harness.session.sendCustomMessage(
				{ customType: "subagent-reply", content: "subagent replied", display: true },
				{ triggerTurn: false },
			);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hi");

		expect(roles(harness.session.messages)).toEqual(["user", "assistant", "toolResult", "custom", "assistant"]);
	});

	it("keeps session entries and message events in the same order as agent state", async () => {
		let notify: (() => Promise<void>) | undefined;
		const slowTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for a background task",
			parameters: Type.Object({}),
			execute: async () => {
				await notify?.();
				return { content: [{ type: "text", text: "tool done" }], details: {} };
			},
		};

		const harness = await createHarness({ tools: [slowTool] });
		harnesses.push(harness);
		notify = () =>
			harness.session.sendCustomMessage(
				{ customType: "subagent-reply", content: "subagent replied", display: true },
				{ triggerTurn: false },
			);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hi");

		const entryKinds = harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "message" ? [entry.message.role] : entry.type === "custom_message" ? ["custom"] : [],
			);
		expect(entryKinds).toEqual(["user", "assistant", "toolResult", "custom", "assistant"]);

		// message events must never describe a message the session tree does not contain yet
		const messageStarts = harness.events.flatMap((event) =>
			event.type === "message_start" ? [event.message.role] : [],
		);
		expect(messageStarts).toEqual(["user", "assistant", "toolResult", "custom", "assistant"]);
	});

	it("produces an llm history where every tool result follows its tool call", async () => {
		let notify: (() => Promise<void>) | undefined;
		const slowTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for a background task",
			parameters: Type.Object({}),
			execute: async () => {
				await notify?.();
				return { content: [{ type: "text", text: "tool done" }], details: {} };
			},
		};

		const harness = await createHarness({ tools: [slowTool] });
		harnesses.push(harness);
		notify = () =>
			harness.session.sendCustomMessage(
				{ customType: "subagent-reply", content: "subagent replied", display: true },
				{ triggerTurn: false },
			);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("second turn"),
		]);

		await harness.session.prompt("hi");
		await harness.session.prompt("and now?");

		const llmMessages = convertToLlm(harness.session.messages);
		const openToolCallIds = new Set<string>();
		for (const message of llmMessages) {
			if (message.role === "assistant") {
				openToolCallIds.clear();
				for (const block of message.content) {
					if (block.type === "toolCall") openToolCallIds.add(block.id);
				}
				continue;
			}
			if (message.role === "toolResult") {
				expect(openToolCallIds.has(message.toolCallId)).toBe(true);
				openToolCallIds.delete(message.toolCallId);
				continue;
			}
			openToolCallIds.clear();
		}
	});
});
