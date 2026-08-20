import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

function createWaitTool(released: Promise<void>): AgentTool {
	return {
		name: "wait",
		label: "Wait",
		description: "Wait until released",
		parameters: Type.Object({}),
		execute: async () => {
			await released;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
}

/** True when a converted user message sits between an assistant toolCall and its toolResult. */
function userInterruptsToolBatch(messages: Message[]): boolean {
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const pendingIds = new Set(
			message.content.filter((block) => block.type === "toolCall").map((block) => block.id),
		);
		if (pendingIds.size === 0) continue;
		for (let j = i + 1; j < messages.length && pendingIds.size > 0; j++) {
			const next = messages[j];
			if (next.role === "toolResult") {
				pendingIds.delete(next.toolCallId);
				continue;
			}
			if (next.role === "user") {
				return true;
			}
		}
	}
	return false;
}

describe("regression #8166: custom message mid-tool-batch ordering", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("does not persist triggerTurn-false custom messages between a toolCall and its toolResult", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const harness = await createHarness({
			tools: [createWaitTool(toolRelease)],
		});
		harnesses.push(harness);

		const waitForToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
		]);

		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "steering-preference", content: "deferred", display: true, details: {} },
			{ triggerTurn: false },
		);

		// Mid-turn append would land the custom message between the assistant toolCall
		// and its toolResult; convertToLlm then emits user in that gap and strict
		// providers 400 on the next turn.
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);

		releaseToolExecution?.();
		await promptPromise;

		const roles = harness.session.messages.map((message) => message.role);
		expect(roles.indexOf("custom")).toBeGreaterThan(roles.indexOf("toolResult"));
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "steering-preference",
			),
		).toBe(true);
		expect(userInterruptsToolBatch(convertToLlm(harness.session.messages))).toBe(false);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "steering-preference"),
		).toBe(true);
	});

	it("delivers triggerTurn-false custom messages from agent_end without another prompt", async () => {
		let sent = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("agent_end", async () => {
						if (sent) return;
						sent = true;
						pi.sendMessage(
							{ customType: "plan-complete", content: "all done", display: true },
							{ triggerTurn: false },
						);
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("reply")]);

		await harness.session.prompt("hello");
		await harness.session.waitForIdle();

		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "plan-complete"),
		).toBe(true);
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "plan-complete"),
		).toBe(true);
	});
});
