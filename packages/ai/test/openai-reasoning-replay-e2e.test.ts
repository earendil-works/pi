import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel, completeSimple as runSimple } from "../src/compat.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	ThinkingLevel,
} from "../src/types.ts";
import { resolveApiKey } from "./oauth.ts";

const codexToken = await resolveApiKey("openai-codex");

interface Target {
	name: string;
	// GPT-6.2 is the first model that removes reasoning after edits of earlier input.
	model: Model<Api>;
	apiKey: string | undefined;
	options?: SimpleStreamOptions;
}

const targets: Target[] = [
	{ name: "OpenAI", model: getModel("openai", "gpt-6.2-sol"), apiKey: process.env.OPENAI_API_KEY },
	{
		name: "Codex over SSE",
		model: getModel("openai-codex", "gpt-6.2-sol"),
		apiKey: codexToken,
		options: { transport: "sse" },
	},
	{
		// WebSocket continuation sends only the new input after previous_response_id.
		name: "Codex over WebSocket",
		model: getModel("openai-codex", "gpt-6.2-sol"),
		apiKey: codexToken,
		options: { transport: "websocket", sessionId: "pi-e2e-reasoning-replay" },
	},
];

const lookup = {
	name: "lookup",
	description: "Look up a numeric value by key.",
	parameters: Type.Object({ key: Type.String() }),
};

function reasoningIds(message: AssistantMessage): string[] {
	return message.content.flatMap((block) =>
		block.type === "thinking" && block.thinkingSignature
			? [(JSON.parse(block.thinkingSignature) as { id: string }).id]
			: [],
	);
}

function removals(message: AssistantMessage): unknown[] {
	return (message.diagnostics ?? [])
		.filter((diagnostic) => diagnostic.type === "openai_input_transformations")
		.flatMap((diagnostic) => diagnostic.details?.transformations as unknown[]);
}

describe.each(targets)("$name reasoning replay conformance", (target) => {
	async function request(context: Context, reasoning: ThinkingLevel): Promise<AssistantMessage> {
		const result = await runSimple(target.model, context, {
			...target.options,
			apiKey: target.apiKey,
			reasoning,
			maxTokens: 4000,
		});
		expect(result.stopReason, result.errorMessage).not.toBe("error");
		return result;
	}

	it.skipIf(!target.apiKey)(
		"replays reasoning without removals until earlier input is edited",
		{ timeout: 300000 },
		async () => {
			const context: Context = {
				systemPrompt: "You are a terse assistant.",
				tools: [lookup],
				messages: [
					{
						role: "user",
						content:
							"First think about which prime factors 982451653 has, then call the lookup tool with key 'alpha'. Then reply with the looked-up value multiplied by 961748941, only the integer.",
						timestamp: 1,
					},
				],
			};
			const toolUse = await request(context, "medium");
			expect(toolUse.stopReason).toBe("toolUse");
			const call = toolUse.content.find((block) => block.type === "toolCall");
			if (call?.type !== "toolCall") throw new Error("Expected a lookup tool call");
			const toolResult: Message = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: "lookup",
				content: [{ type: "text", text: "7919" }],
				isError: false,
				timestamp: 2,
			};

			// Same turn after the tool result.
			context.messages.push(toolUse, toolResult);
			const answer = await request(context, "medium");
			expect(removals(answer)).toEqual([]);

			// Next turn with a thinking level change, which goes out as a configuration_update item.
			context.messages.push(answer, {
				role: "user",
				content: "Multiply that by 982451653. Only the integer.",
				timestamp: 3,
			});
			const higherEffort = await request(context, "high");
			expect(removals(higherEffort)).toEqual([]);

			// Next turn after a mid-conversation system update.
			context.messages.push(
				higherEffort,
				{ role: "system", content: "From now on, answer in German words.", timestamp: 4 },
				{
					role: "user",
					content: "Compute the digit sum of that number, then square it. Only the integer.",
					timestamp: 5,
				},
			);
			const afterSystemUpdate = await request(context, "high");
			expect(removals(afterSystemUpdate)).toEqual([]);

			// Editing the tool result removes the reasoning that followed it, and only that.
			const toolResultIndex = context.messages.indexOf(toolResult);
			context.messages[toolResultIndex] = { ...toolResult, content: [{ type: "text", text: "7907" }] };
			context.messages.push(afterSystemUpdate, { role: "user", content: "Say ok.", timestamp: 6 });
			const afterEdit = await request(context, "high");
			const followingReasoning = [answer, higherEffort, afterSystemUpdate].flatMap(reasoningIds);
			expect(followingReasoning.length).toBeGreaterThan(0);
			expect(removals(afterEdit)).toEqual(
				followingReasoning.map((id) => ({ type: "reasoning", id, action: "removed", reason: "prefix_mismatch" })),
			);
		},
	);
});
