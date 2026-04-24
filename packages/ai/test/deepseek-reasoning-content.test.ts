import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";
import type { AssistantMessage, Context, Model } from "../src/types.js";

interface DeepSeekCapturedPayload {
	messages: Array<{
		role: string;
		content?: unknown;
		reasoning_content?: string;
		tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
	}>;
}

async function capturePayload(context: Context): Promise<DeepSeekCapturedPayload> {
	const model = getModel("deepseek", "deepseek-v4-pro") as Model<"openai-completions">;
	const captureModel: Model<"openai-completions"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	let captured: DeepSeekCapturedPayload | undefined;
	const s = streamSimple(captureModel, context, {
		apiKey: "fake-key",
		onPayload: (payload) => {
			captured = payload as DeepSeekCapturedPayload;
			return payload;
		},
	});

	await s.result();

	if (!captured) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return captured;
}

function makeAssistantMsg(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-pro",
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
	};
}

describe("DeepSeek reasoning_content round-trip on assistant history", () => {
	it("carries the actual thinking text when the prior assistant turn had reasoning", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: Date.now() },
				makeAssistantMsg([
					{ type: "thinking", thinking: "Let me ponder this carefully." },
					{ type: "text", text: "Hello!" },
				]),
				{ role: "user", content: "continue", timestamp: Date.now() },
			],
		};

		const payload = await capturePayload(context);
		const asst = payload.messages.find((m) => m.role === "assistant");

		expect(asst).toBeDefined();
		expect(asst?.reasoning_content).toBe("Let me ponder this carefully.");
	});

	it("joins multiple thinking blocks with newline", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: Date.now() },
				makeAssistantMsg([
					{ type: "thinking", thinking: "First thought." },
					{ type: "thinking", thinking: "Second thought." },
					{ type: "text", text: "Done." },
				]),
				{ role: "user", content: "continue", timestamp: Date.now() },
			],
		};

		const payload = await capturePayload(context);
		const asst = payload.messages.find((m) => m.role === "assistant");

		expect(asst?.reasoning_content).toBe("First thought.\nSecond thought.");
	});

	it("filters empty / whitespace-only thinking blocks before joining", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: Date.now() },
				makeAssistantMsg([
					{ type: "thinking", thinking: "" },
					{ type: "thinking", thinking: "   " },
					{ type: "thinking", thinking: "Real thought." },
					{ type: "text", text: "OK." },
				]),
				{ role: "user", content: "continue", timestamp: Date.now() },
			],
		};

		const payload = await capturePayload(context);
		const asst = payload.messages.find((m) => m.role === "assistant");

		expect(asst?.reasoning_content).toBe("Real thought.");
	});

	it("falls back to empty string when the prior assistant turn had tool_calls but no thinking (the 400-producing case)", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "search for something", timestamp: Date.now() },
				makeAssistantMsg([
					{
						type: "toolCall",
						id: "call_xyz",
						name: "search",
						arguments: { query: "hi" },
					},
				]),
				{
					role: "toolResult",
					toolCallId: "call_xyz",
					toolName: "search",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: Date.now(),
				},
				{ role: "user", content: "continue", timestamp: Date.now() },
			],
		};

		const payload = await capturePayload(context);
		const asst = payload.messages.find((m) => m.role === "assistant");

		expect(asst).toBeDefined();
		expect(asst?.reasoning_content).toBe("");
		expect(asst?.tool_calls?.[0]?.id).toBe("call_xyz");
	});

	it("falls back to empty string when prior assistant turn has text but no thinking", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: Date.now() },
				makeAssistantMsg([{ type: "text", text: "Just text, no reasoning this turn." }]),
				{ role: "user", content: "continue", timestamp: Date.now() },
			],
		};

		const payload = await capturePayload(context);
		const asst = payload.messages.find((m) => m.role === "assistant");

		expect(asst?.reasoning_content).toBe("");
	});
});
