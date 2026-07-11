/**
 * The Message types require `content` to always be present, but untyped JS
 * extension tools, hand-built histories, and old or hand-edited session files
 * can violate that contract. We are intentionally lax at the ingestion
 * boundaries and normalize null/missing content to an empty array so it never
 * reaches rendering, compaction, or provider request conversion
 * (issues #6259, #6276).
 */

import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { type SessionEntry, sessionEntryToContextMessages } from "../../src/core/session-manager.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness } from "./harness.ts";

function messageEntry(message: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	} as unknown as SessionEntry;
}

describe("lax message content handling", () => {
	it("normalizes tool results from untyped tools that omit content", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.registerTool({
					name: "web_search",
					label: "Web Search",
					description: "Custom tool that returns a result without content",
					parameters: Type.Object({}),
					// Simulate an untyped JS extension tool that omits content.
					execute: async () => ({ details: {} }) as unknown as AgentToolResult<unknown>,
				});
			},
		];
		const harness = await createHarness({ extensionFactories });

		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("web_search", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("search something");

			const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
			expect(toolResults).toHaveLength(1);
			expect(toolResults[0].content).toEqual([]);
			// The follow-up turn consumed the normalized tool result without crashing.
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("normalizes null content in message_end extension replacements", async () => {
		const extensionFactories: ExtensionFactory[] = [
			(pi) => {
				pi.on("message_end", async (event) => {
					if (event.message.role !== "assistant") return undefined;
					// Simulate an untyped JS extension replacing a message without content.
					return { message: { ...event.message, content: null } as unknown as AgentMessage };
				});
			},
		];
		const harness = await createHarness({ extensionFactories });

		try {
			harness.setResponses([fauxAssistantMessage("hello")]);
			await harness.session.prompt("hi");

			const assistantMessages = harness.session.messages.filter((message) => message.role === "assistant");
			expect(assistantMessages).toHaveLength(1);
			expect(assistantMessages[0].content).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("normalizes null content in custom messages from extensions", async () => {
		const harness = await createHarness();

		try {
			await harness.session.sendCustomMessage({
				customType: "test",
				content: null as unknown as string,
				display: false,
				details: undefined,
			});

			const customMessages = harness.session.messages.filter((message) => message.role === "custom");
			expect(customMessages).toHaveLength(1);
			expect(customMessages[0].content).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("normalizes null or missing content when loading session message entries", () => {
		const badMessages = [
			{ role: "user", content: null, timestamp: Date.now() },
			{
				role: "assistant",
				content: null,
				api: "openai-completions",
				provider: "openai",
				model: "test-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "web_search",
				isError: false,
				timestamp: Date.now(),
			},
		];

		for (const badMessage of badMessages) {
			const [message] = sessionEntryToContextMessages(messageEntry(badMessage));
			expect(message).toMatchObject({ role: badMessage.role, content: [] });
		}
	});

	it("normalizes null content when loading custom message entries", () => {
		const entry = {
			type: "custom_message",
			id: "entry-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "test",
			content: null,
			display: false,
			details: undefined,
		} as unknown as SessionEntry;

		const [message] = sessionEntryToContextMessages(entry);
		expect(message).toMatchObject({ role: "custom", content: [] });
	});

	it("keeps valid message content untouched when loading session entries", () => {
		const [message] = sessionEntryToContextMessages(
			messageEntry({ role: "user", content: "hello", timestamp: Date.now() }),
		);
		expect(message).toMatchObject({ role: "user", content: "hello" });
	});
});
