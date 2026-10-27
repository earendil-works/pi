/**
 * Radius drops replayed Anthropic thinking (e2e, needs real credentials).
 *
 * Problem: when a client sends a Claude reply back to the model in a later request, the reply's signed thinking blocks
 * should become part of the model's context. Through Radius they are silently dropped: the model never sees its
 * earlier reasoning, and the provider reports no input tokens for it.
 *
 * How it was found: a Pi Mobile session on radius/claude-opus-5-5 reached ~996K context tokens, but its compaction
 * request was 1.38M tokens ("prompt is too long"). Compaction serializes all assistant thinking as text, while the
 * live context had been carrying none of it.
 *
 * Mechanism: Claude models with managed effort (`compat.supportsMidConvoEffort`) bind each signed thinking block to
 * the effort level of the request that produced it. `anthropic-messages` records that level on the assistant message as
 * `providerThinkingLevel` and replays it as an effort marker next to the block. The request also sets
 * `thinking.block_binding.prefix_mismatch_behavior = "drop_block"`, so a block whose marker is missing is dropped
 * without an error. Direct Anthropic replies carry `providerThinkingLevel: "high"`. Radius replies do not: its
 * pi-messages `done` event omits `providerThinkingLevel`, although the client parses it (see `pi-messages.ts`). Radius
 * does honor the field when a client sends it, so the fix is for Radius to return it.
 *
 * Measurement: get one real reply with thinking and a tool call, then send the follow-up request twice, once with the
 * reply unchanged and once with its thinking blocks removed. Kept thinking makes the first request larger by roughly the
 * reply's thinking tokens; dropped thinking makes both requests the same size. Observed on claude-opus-5-5:
 *
 *   anthropic                       with 970, without 605 (+365 of 413 output tokens)
 *   radius                          with 582, without 582 (+0 of 463 output tokens)
 *   radius, level "high" injected   with 997, without 582
 *
 * Credentials: RADIUS_API_KEY or a `radius` entry in ~/.pi/agent/auth.json; ANTHROPIC_API_KEY, ANTHROPIC_OAUTH_TOKEN or
 * an `anthropic` entry for the control. Each test makes three paid requests.
 */
import { describe, expect, it } from "vitest";
import { completeSimple, getModel } from "../src/compat.ts";
import { getEnvApiKey } from "../src/env-api-keys.ts";
import type { Api, AssistantMessage, Context, Message, Model, Tool, ToolResultMessage } from "../src/types.ts";
import { resolveApiKey } from "./oauth.ts";

const radiusKey = process.env.RADIUS_API_KEY ?? (await resolveApiKey("radius"));
const anthropicKey = getEnvApiKey("anthropic") ?? (await resolveApiKey("anthropic"));

const tool: Tool = {
	name: "lookup",
	description: "Look up a value by key.",
	parameters: {
		type: "object",
		properties: { key: { type: "string" } },
		required: ["key"],
	} as unknown as Tool["parameters"],
};

const user: Message = {
	role: "user",
	content:
		"First, think carefully: list every prime between 100 and 300 in your head and sum them. " +
		"Then call the lookup tool with key equal to that sum. Do not write the primes in your visible reply.",
	timestamp: 1,
};

/** Input tokens the provider reports for the request, cached or not. */
function inputTokens(message: AssistantMessage): number {
	return message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
}

function request<TApi extends Api>(model: Model<TApi>, apiKey: string, messages: Message[]): Promise<AssistantMessage> {
	const context: Context = { systemPrompt: "You are a careful assistant.", messages, tools: [tool] };
	return completeSimple(model, context, { apiKey, reasoning: "high", maxTokens: 16000, cacheRetention: "none" });
}

/** A real reply with signed thinking and a tool call, plus the tool result that answers it. */
async function thinkingTurn<TApi extends Api>(
	model: Model<TApi>,
	apiKey: string,
): Promise<{ reply: AssistantMessage; result: ToolResultMessage }> {
	const reply = await request(model, apiKey, [user]);
	expect(reply.stopReason, reply.errorMessage).toBe("toolUse");
	expect(reply.content.some((block) => block.type === "thinking" && (block.thinkingSignature ?? "").length > 0)).toBe(
		true,
	);
	const call = reply.content.find((block) => block.type === "toolCall");
	if (call?.type !== "toolCall") throw new Error("reply has no tool call");
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: "value: 42" }],
		isError: false,
		timestamp: 2,
	};
	return { reply, result };
}

/** Input tokens `reply`'s thinking adds to the follow-up request. */
async function replayedThinkingTokens<TApi extends Api>(
	model: Model<TApi>,
	apiKey: string,
	reply: AssistantMessage,
	result: ToolResultMessage,
): Promise<number> {
	const withoutThinking: AssistantMessage = {
		...reply,
		content: reply.content.filter((block) => block.type !== "thinking"),
	};
	const [kept, stripped] = await Promise.all([
		request(model, apiKey, [user, reply, result]),
		request(model, apiKey, [user, withoutThinking, result]),
	]);
	expect(kept.stopReason, kept.errorMessage).not.toBe("error");
	expect(stripped.stopReason, stripped.errorMessage).not.toBe("error");
	return inputTokens(kept) - inputTokens(stripped);
}

describe("replayed Claude thinking stays in context", () => {
	it.skipIf(!anthropicKey)("anthropic keeps it (control)", { timeout: 180000 }, async () => {
		const model = getModel("anthropic", "claude-opus-5-5");
		const { reply, result } = await thinkingTurn(model, anthropicKey!);
		expect(reply.providerThinkingLevel).toBe("high");
		const added = await replayedThinkingTokens(model, anthropicKey!, reply, result);
		expect(added).toBeGreaterThan(0.5 * reply.usage.output);
	});

	it.skipIf(!radiusKey)("radius keeps it", { timeout: 180000 }, async () => {
		const model = getModel("radius", "claude-opus-5-5");
		const { reply, result } = await thinkingTurn(model, radiusKey!);
		// Cause: without this level, the replayed block has no effort marker and Anthropic drops it.
		expect.soft(reply.providerThinkingLevel, "radius done event omits providerThinkingLevel").toBe("high");
		// Effect: the follow-up request reports no input tokens for the thinking.
		const added = await replayedThinkingTokens(model, radiusKey!, reply, result);
		expect(added, "radius dropped the replayed thinking").toBeGreaterThan(0.5 * reply.usage.output);
	});

	it.skipIf(!radiusKey)("radius keeps it when the client supplies the level", { timeout: 180000 }, async () => {
		const model = getModel("radius", "claude-opus-5-5");
		const { reply, result } = await thinkingTurn(model, radiusKey!);
		const added = await replayedThinkingTokens(
			model,
			radiusKey!,
			{ ...reply, providerThinkingLevel: "high" },
			result,
		);
		expect(added).toBeGreaterThan(0.5 * reply.usage.output);
	});
});
