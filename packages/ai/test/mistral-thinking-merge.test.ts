import { describe, expect, it } from "vitest";
import { complete, getModel } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

interface MistralWireContentChunk {
	type: string;
	text?: string;
	thinking?: Array<{ type: string; text: string }>;
}

interface MistralWireAssistantMessage {
	role: string;
	content?: MistralWireContentChunk[];
}

function captureAssistantMessages(): {
	assistantMessages: () => MistralWireAssistantMessage[] | undefined;
	onPayload: (payload: unknown) => unknown;
} {
	let messages: MistralWireAssistantMessage[] | undefined;
	return {
		assistantMessages: () => messages,
		onPayload: (payload) => {
			messages = ((payload as { messages?: MistralWireAssistantMessage[] }).messages ?? []).filter(
				(msg) => msg.role === "assistant",
			);
			return payload;
		},
	};
}

describe("Mistral assistant thinking serialization", () => {
	it("merges fragmented thinking blocks into one leading thinking chunk", async () => {
		const model: Model<"mistral-conversations"> = {
			...getModel("mistral", "devstral-medium-latest"),
			baseUrl: "http://127.0.0.1:9",
		};
		// Mirrors what GLM models on Mistral produce when the stream fragments:
		// several thinking blocks interleaved with empty text blocks.
		const context: Context = {
			messages: [
				{ role: "user", content: "Hi", timestamp: Date.now() },
				{
					role: "assistant",
					provider: "mistral",
					api: "mistral-conversations",
					model: "devstral-medium-latest",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
					content: [
						{ type: "text", text: "" },
						{ type: "thinking", thinking: "first fragment" },
						{ type: "text", text: "" },
						{ type: "thinking", thinking: "second fragment" },
						{ type: "text", text: "final answer text" },
					],
				},
				{ role: "user", content: "Continue", timestamp: Date.now() },
			],
		};

		const capture = captureAssistantMessages();
		await complete(model, context, { apiKey: "fake-key", onPayload: capture.onPayload });

		const assistantMessages = capture.assistantMessages();
		expect(assistantMessages).toHaveLength(1);
		const content = assistantMessages?.[0]?.content;
		expect(content).toBeTruthy();

		const thinkingChunks = (content ?? []).filter((chunk) => chunk.type === "thinking");
		expect(thinkingChunks).toHaveLength(1);

		// The merged thinking chunk must be the first content part...
		expect(content?.[0]?.type).toBe("thinking");
		// ...and must contain all fragments joined together.
		expect(content?.[0]?.thinking).toEqual([{ type: "text", text: "first fragment\nsecond fragment" }]);

		const textChunks = (content ?? []).filter((chunk) => chunk.type === "text");
		expect(textChunks).toEqual([{ type: "text", text: "final answer text" }]);
	});

	it("keeps single thinking blocks unchanged", async () => {
		const model: Model<"mistral-conversations"> = {
			...getModel("mistral", "devstral-medium-latest"),
			baseUrl: "http://127.0.0.1:9",
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "Hi", timestamp: Date.now() },
				{
					role: "assistant",
					provider: "mistral",
					api: "mistral-conversations",
					model: "devstral-medium-latest",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
					content: [
						{ type: "thinking", thinking: "only fragment" },
						{ type: "text", text: "answer" },
					],
				},
				{ role: "user", content: "Continue", timestamp: Date.now() },
			],
		};

		const capture = captureAssistantMessages();
		await complete(model, context, { apiKey: "fake-key", onPayload: capture.onPayload });

		const assistantMessages = capture.assistantMessages();
		expect(assistantMessages).toHaveLength(1);
		const content = assistantMessages?.[0]?.content;
		const thinkingChunks = (content ?? []).filter((chunk) => chunk.type === "thinking");
		expect(thinkingChunks).toHaveLength(1);
		expect(content?.[0]?.thinking).toEqual([{ type: "text", text: "only fragment" }]);
	});
});
