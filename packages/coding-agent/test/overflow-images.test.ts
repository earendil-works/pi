import type { ImageContent, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { capImagesToByteBudget } from "../src/core/overflow-images.ts";

function img(bytes: number): ImageContent {
	return { type: "image", data: "x".repeat(bytes), mimeType: "image/png" };
}

function toolResult(content: (ImageContent | { type: "text"; text: string })[], id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "screenshot",
		content: content as ToolResultMessage["content"],
		isError: false,
		timestamp: Number(id),
	};
}

describe("capImagesToByteBudget", () => {
	it("keeps everything (same reference) when images fit the budget", () => {
		const messages: Message[] = [
			toolResult([{ type: "text", text: "a" }, img(100)], "1"),
			toolResult([img(100)], "2"),
		];
		const result = capImagesToByteBudget(messages, 1000);
		expect(result.droppedImages).toBe(0);
		expect(result.messages).toBe(messages);
	});

	it("drops the OLDEST images first until within the byte budget", () => {
		const messages: Message[] = [
			toolResult([img(100)], "1"), // oldest
			toolResult([img(100)], "2"),
			toolResult([img(100)], "3"), // newest
		];
		// budget 250 -> keep newest two (200), drop oldest one
		const result = capImagesToByteBudget(messages, 250);
		expect(result.droppedImages).toBe(1);
		expect((result.messages[0] as ToolResultMessage).content[0].type).toBe("text");
		expect((result.messages[1] as ToolResultMessage).content[0].type).toBe("image");
		expect((result.messages[2] as ToolResultMessage).content[0].type).toBe("image");
	});

	it("preserves sibling text blocks when dropping an image", () => {
		const messages: Message[] = [toolResult([{ type: "text", text: "keep me" }, img(100)], "1")];
		const result = capImagesToByteBudget(messages, 0);
		expect(result.droppedImages).toBe(1);
		const content = (result.messages[0] as ToolResultMessage).content;
		expect(content[0]).toEqual({ type: "text", text: "keep me" });
		expect(content[1].type).toBe("text"); // image replaced by placeholder text
	});

	it("does not mutate the input array", () => {
		const messages: Message[] = [toolResult([img(100)], "1"), toolResult([img(100)], "2")];
		const before = JSON.stringify(messages);
		capImagesToByteBudget(messages, 50);
		expect(JSON.stringify(messages)).toBe(before);
	});

	it("ignores user string content and assistant messages", () => {
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				timestamp: 2,
				model: "m",
				provider: "p",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
			} as Message,
			toolResult([img(100)], "1"),
		];
		const result = capImagesToByteBudget(messages, 10);
		expect(result.droppedImages).toBe(1);
	});
});
