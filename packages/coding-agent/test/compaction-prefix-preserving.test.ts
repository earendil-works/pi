import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { generateSummaryWithUsage } from "../src/core/compaction/index.ts";

// The prefix-preserving path reuses the conversation's own prefix (system
// prompt, tool declarations, messages) and appends a single user instruction,
// so the summarization request hits the provider prefix cache instead of
// paying a full prefill.

const conversation: AgentMessage[] = [
	{
		role: "user",
		content: [{ type: "text", text: "Remember the word BANANA." }],
		timestamp: 1,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: "BANANA noted." }],
		timestamp: 2,
	},
];

const tools = [
	{
		name: "read",
		description: "Read file contents",
		parameters: { type: "object", properties: {}, required: [] },
	},
] as any;

function captureContext() {
	const captured: any[] = [];
	// streamFn contract: returns { result: () => AssistantMessage }
	const wrapped = (async (_model: any, context: any, _options: any) => {
		captured.push(context);
		return {
			result: async () => ({
				content: [{ type: "text", text: "SUMMARY" }],
				usage: { input: 1, output: 1 } as any,
			}),
		};
	}) as any;
	return { wrapped, captured };
}

describe("prefix-preserving compaction", () => {
	it("legacy path keeps the serialized fresh prompt", async () => {
		const { wrapped, captured } = captureContext();
		await generateSummaryWithUsage(conversation, {} as any, undefined, undefined, undefined, undefined, undefined, undefined, undefined, wrapped, undefined, undefined, undefined, "s1");
		const ctx = JSON.stringify(captured[0]);
		expect(ctx).toContain("<conversation>");
		expect(ctx).not.toContain("THE-SESSION-SYSTEM-PROMPT");
	});

	it("prefix-preserving path replays messages with the session system prompt and tools", async () => {
		const { wrapped, captured } = captureContext();
		await generateSummaryWithUsage(
			conversation,
			{} as any,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			wrapped,
			undefined,
			undefined,
			undefined,
			"s1",
			"THE-SESSION-SYSTEM-PROMPT",
			tools,
		);
		const ctx = JSON.stringify(captured[0]);
		expect(ctx).not.toContain("<conversation>");
		expect(ctx).toContain("THE-SESSION-SYSTEM-PROMPT");
		expect(ctx).toContain("BANANA noted.");
		expect(ctx).toContain("The messages above");
		expect(ctx).toContain("read");
	});

	it("prefix-preserving instruction carries the previous summary", async () => {
		const { wrapped, captured } = captureContext();
		await generateSummaryWithUsage(
			conversation,
			{} as any,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"prior summary text",
			undefined,
			wrapped,
			undefined,
			undefined,
			undefined,
			"s1",
			"THE-SESSION-SYSTEM-PROMPT",
			tools,
		);
		const ctx = captured[0];
		const last = ctx.messages[ctx.messages.length - 1];
		expect(last.role).toBe("user");
		expect(JSON.stringify(last.content)).toContain("prior summary text");
		expect(JSON.stringify(ctx)).not.toContain("<conversation>");
	});
});
