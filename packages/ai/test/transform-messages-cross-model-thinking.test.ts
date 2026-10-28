import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Model } from "../src/types.ts";

const kimi: Model<"openai-completions"> = {
	id: "moonshotai/Kimi-K3",
	name: "Kimi K3",
	api: "openai-completions",
	provider: "sference",
	baseUrl: "https://api.sference.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1048576,
	maxTokens: 32768,
};

function assistant(model: string, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "sference",
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("thinking from other models", () => {
	// https://github.com/earendil-works/pi/issues/10995
	it("does not send another model's readable thinking as text", () => {
		const messages: Message[] = [
			{ role: "user", content: "Why does curl work but node fails?", timestamp: Date.now() },
			assistant("zai-org/GLM-5.3", [
				{
					type: "thinking",
					thinking: "The user asks about ECONNRESET. Candidates: proxy, IPv6, TLS.",
					thinkingSignature: "reasoning_content",
				},
				{ type: "text", text: "Let me check the TLS versions." },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "curl -v" } },
			]),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [{ type: "text", text: "TLSv1.2" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, kimi);
		const assistantMsg = result.find((m) => m.role === "assistant") as AssistantMessage;

		expect(assistantMsg.content).toEqual([
			{ type: "text", text: "Let me check the TLS versions." },
			{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "curl -v" } },
		]);
	});

	it("keeps thinking only from the target model when models alternate", () => {
		const thinking = (text: string) => ({
			type: "thinking" as const,
			thinking: text,
			thinkingSignature: "reasoning_content",
		});
		const messages: Message[] = [
			{ role: "user", content: "1", timestamp: Date.now() },
			{ ...assistant("moonshotai/Kimi-K3", [thinking("kimi 1"), { type: "text", text: "a" }]), stopReason: "stop" },
			{ role: "user", content: "2", timestamp: Date.now() },
			{ ...assistant("zai-org/GLM-5.3", [thinking("glm 1"), { type: "text", text: "b" }]), stopReason: "stop" },
			{ role: "user", content: "3", timestamp: Date.now() },
			{ ...assistant("moonshotai/Kimi-K3", [thinking("kimi 2"), { type: "text", text: "c" }]), stopReason: "stop" },
			{ role: "user", content: "4", timestamp: Date.now() },
			{ ...assistant("zai-org/GLM-5.3", [thinking("glm 2"), { type: "text", text: "d" }]), stopReason: "stop" },
			{ role: "user", content: "hi", timestamp: Date.now() },
		];

		const result = transformMessages(messages, kimi);
		const contents = result.filter((m) => m.role === "assistant").map((m) => (m as AssistantMessage).content);

		expect(contents).toEqual([
			[thinking("kimi 1"), { type: "text", text: "a" }],
			[{ type: "text", text: "b" }],
			[thinking("kimi 2"), { type: "text", text: "c" }],
			[{ type: "text", text: "d" }],
		]);
	});
});
