import { describe, expect, it } from "vitest";
import { stream } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

interface WireMessage {
	role: string;
	content: unknown;
	output_config?: { effort?: string };
}

interface CapturedPayload {
	messages: WireMessage[];
	thinking?: {
		type: string;
		display?: string;
		block_binding?: { prefix_mismatch_behavior?: string };
	};
	output_config?: { effort?: string };
	fallbacks?: Array<{ model: string }>;
}

function managedModel(provider = "anthropic"): Model<"anthropic-messages"> {
	return {
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1",
		api: "anthropic-messages",
		provider,
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", max: "max" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true },
	};
}

function assistant(model: Model<"anthropic-messages">, level?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "reasoning", thinkingSignature: "signature" },
			{ type: "text", text: "answer" },
		],
		api: "anthropic-messages",
		provider: model.provider,
		model: model.id,
		...(level === undefined ? {} : { providerThinkingLevel: level }),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

async function capture(
	model: Model<"anthropic-messages">,
	context: Context,
	effort?: "low" | "medium" | "high" | "xhigh" | "max",
): Promise<{ payload: CapturedPayload; message: AssistantMessage }> {
	let payload: CapturedPayload | undefined;
	const result = stream(model, context, {
		apiKey: "test-key",
		cacheRetention: "none",
		thinkingEnabled: true,
		effort,
		onPayload: (value) => {
			payload = value as CapturedPayload;
			throw new Error("payload captured");
		},
	});
	const message = await result.result();
	if (!payload) throw new Error("Expected payload capture");
	return { payload, message };
}

const user = (text: string, timestamp: number) => ({ role: "user" as const, content: text, timestamp });

function effortMessages(payload: CapturedPayload): WireMessage[] {
	return payload.messages.filter((message) => message.role === "system");
}

describe("Anthropic mid-conversation effort", () => {
	it("reconstructs an exact historical marker prefix and appends the current marker", async () => {
		const model = managedModel();
		const first = await capture(model, { messages: [user("one", 1)] }, "low");
		const second = await capture(
			model,
			{ messages: [user("one", 1), assistant(model, "low"), user("two", 2)] },
			"high",
		);

		expect(first.payload.messages).toEqual([
			{ role: "user", content: "one" },
			{ role: "system", content: [], output_config: { effort: "low" } },
		]);
		expect(second.payload.messages.slice(0, first.payload.messages.length)).toEqual(first.payload.messages);
		expect(second.payload.messages.at(-1)).toEqual({
			role: "system",
			content: [],
			output_config: { effort: "high" },
		});
		expect(first.payload.output_config).toEqual({ effort: "high" });
		expect(second.payload.output_config).toEqual({ effort: "high" });
		expect(second.payload.thinking).toEqual({
			type: "adaptive",
			display: "summarized",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		});
		expect(first.message.providerThinkingLevel).toBe("low");
	});

	it.each(["low", "medium", "high", "xhigh", "max"] as const)("preserves native effort %s", async (effort) => {
		const model = managedModel();
		const { payload, message } = await capture(model, { messages: [user("one", 1)] }, effort);
		expect(effortMessages(payload)).toEqual([{ role: "system", content: [], output_config: { effort } }]);
		expect(message.providerThinkingLevel).toBe(effort);
	});

	it("defaults omitted effort to high and still enables drop_block", async () => {
		const { payload, message } = await capture(managedModel(), { messages: [user("one", 1)] });
		expect(payload.messages.at(-1)).toEqual({
			role: "system",
			content: [],
			output_config: { effort: "high" },
		});
		expect(payload.thinking?.block_binding?.prefix_mismatch_behavior).toBe("drop_block");
		expect(message.providerThinkingLevel).toBe("high");
	});

	it("does not invent markers for legacy or other-provider assistants", async () => {
		const model = managedModel();
		const legacy = assistant(model);
		const otherProvider = { ...assistant(model, "low"), provider: "other-provider" };
		const { payload } = await capture(
			model,
			{ messages: [user("one", 1), legacy, user("two", 2), otherProvider, user("three", 3)] },
			"medium",
		);
		expect(effortMessages(payload)).toEqual([{ role: "system", content: [], output_config: { effort: "medium" } }]);
	});

	it("leaves unsupported models on top-level effort", async () => {
		const model = managedModel();
		model.compat = { forceAdaptiveThinking: true };
		const { payload, message } = await capture(model, { messages: [user("one", 1)] }, "low");
		expect(payload.messages).toEqual([{ role: "user", content: "one" }]);
		expect(payload.output_config).toEqual({ effort: "low" });
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(message.providerThinkingLevel).toBeUndefined();
	});

	it("sends the effort and binding beta headers", async () => {
		let betaHeader: string | null = null;
		const events = [
			{
				type: "message_start",
				message: {
					id: "msg_test",
					model: "claude-fable-5-1",
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 1, output_tokens: 1 },
			},
			{ type: "message_stop" },
		];
		const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
		const fetchImpl: typeof fetch = async (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			betaHeader = request.headers.get("anthropic-beta");
			return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		};
		const result = await stream(
			managedModel(),
			{ messages: [user("one", 1)] },
			{
				apiKey: "test-key",
				cacheRetention: "none",
				fetch: fetchImpl,
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(betaHeader).toContain("mid-conversation-output-config-2026-07-01");
		expect(betaHeader).toContain("thinking-binding-controls-2026-08-01");
	});

	it("generates exact model and transport gates", () => {
		const direct = getModel("anthropic", "claude-fable-5-1");
		const openRouter = getModel("openrouter", "anthropic/claude-fable-5.1");
		const unsupported = getModel("anthropic", "claude-opus-4-8");
		expect(direct.compat?.supportsMidConvoEffort).toBe(true);
		expect(direct.thinkingLevelMap?.off).toBeNull();
		expect(openRouter.api).toBe("anthropic-messages");
		expect(openRouter.baseUrl).toBe("https://openrouter.ai/api");
		expect(openRouter.compat?.supportsMidConvoEffort).toBe(true);
		expect(unsupported.compat?.supportsMidConvoEffort).toBeUndefined();
		expect(getModel("anthropic", "claude-opus-5").compat?.allowedFallbackModels).toBeUndefined();
	});
});
