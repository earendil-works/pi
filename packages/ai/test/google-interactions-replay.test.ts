import { describe, expect, it } from "vitest";
import { stream } from "../src/api/google-interactions.ts";
import { GOOGLE_AI_PLAN_MODELS } from "../src/providers/google-ai-plan.models.ts";
import type { AssistantMessage, FetchFunction, Message } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model = GOOGLE_AI_PLAN_MODELS["gemini-4-hydrogen"];
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(source: { api: string; provider: string; model: string }): AssistantMessage {
	return {
		role: "assistant",
		...source,
		content: [
			{ type: "thinking", thinking: "Read the file first.", thinkingSignature: "c2lnbmF0dXJl" },
			{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.py" } },
		],
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	};
}

const messages = (previous: AssistantMessage): Message[] => [
	{ role: "user", content: "Read a.py", timestamp: 0 },
	previous,
	{
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "read_file",
		content: [{ type: "text", text: "x = 1" }],
		isError: false,
		timestamp: 0,
	},
];

async function sentSteps(history: Message[]): Promise<unknown[]> {
	let body = "";
	const fetch: FetchFunction = async (_url, init) => {
		body = String(init?.body);
		return new Response("", { status: 500 });
	};
	await stream(model, normalizeContext({ messages: history }), {
		headers: { Authorization: "Bearer token" },
		fetch,
	}).result();
	return (JSON.parse(body) as { input: unknown[] }).input;
}

describe("google-interactions history replay", () => {
	it("replays the model's own signed thought before its function call", async () => {
		const steps = await sentSteps(
			messages(assistant({ api: "google-interactions", provider: model.provider, model: model.id })),
		);
		expect(steps.slice(1, 3)).toEqual([
			{ type: "thought", signature: "c2lnbmF0dXJl", summary: [{ type: "text", text: "Read the file first." }] },
			{ type: "function_call", id: "call_1", name: "read_file", arguments: { path: "a.py" } },
		]);
	});

	it("marks function calls from another model with Google's skip sentinel", async () => {
		const steps = await sentSteps(
			messages(assistant({ api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5" })),
		);
		expect(steps.slice(1, 3)).toEqual([
			{ type: "thought", signature: "skip_thought_signature_validator" },
			{ type: "function_call", id: "call_1", name: "read_file", arguments: { path: "a.py" } },
		]);
	});
});
