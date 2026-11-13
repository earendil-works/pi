import { describe, expect, it } from "vitest";
import { convertMessages, requiresFunctionCallThoughtSignature, requiresToolCallId } from "../src/api/google-shared.ts";
import type { Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// base64 of "skip_thought_signature_validator", pinned so the test checks the wire bytes.
const SKIP_B64 = "c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=";

function makeGemini3Model<TApi extends "google-generative-ai" | "google-vertex">(
	api: TApi,
	provider: Model<TApi>["provider"],
	id = "gemini-3-pro-preview",
): Model<TApi> {
	return {
		id,
		name: "Gemini 3 Pro Preview",
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function makeContext(model: { api: string; provider: string; id: string }, thoughtSignature?: string): Context {
	const now = Date.now();
	return {
		messages: [
			{ role: "user", content: "Hi", timestamp: now },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "bash",
						arguments: { command: "echo hi" },
						...(thoughtSignature && { thoughtSignature }),
					},
					{
						type: "toolCall",
						id: "call_2",
						name: "bash",
						arguments: { command: "ls -la" },
					},
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [{ type: "text", text: "hi" }],
				isError: false,
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: "call_2",
				toolName: "bash",
				content: [{ type: "text", text: "files" }],
				isError: false,
				timestamp: now,
			},
		],
	};
}

describe("google-shared convertMessages — Gemini 3 unsigned tool calls", () => {
	it.each([
		makeGemini3Model("google-generative-ai", "google"),
		makeGemini3Model("google-generative-ai", "google", "gemini-3.6-flash"),
		makeGemini3Model("google-vertex", "google-vertex"),
	])("preserves tool call IDs for $id via $api history", (model) => {
		const context = makeContext(model);
		const contents = convertMessages(model, normalizeContext(context));
		const functionCallIds = contents
			.flatMap((content) => content.parts ?? [])
			.flatMap((part) => (part.functionCall?.id ? [part.functionCall.id] : []));
		const functionResponseIds = contents
			.flatMap((content) => content.parts ?? [])
			.flatMap((part) => (part.functionResponse?.id ? [part.functionResponse.id] : []));

		expect(functionCallIds).toEqual(["call_1", "call_2"]);
		expect(functionResponseIds).toEqual(["call_1", "call_2"]);
	});

	// Live Vertex probe 2026-11-13 (gemini-4-carbon/-hydrogen/-argon, 3.8-flash, 3.1-pro-preview, 3-flash-preview):
	// no signed call in a turn -> 400 "Function call is missing a thought_signature"; base64 bypass on the
	// first call with the sibling unsigned -> 200.
	it("signs only the first call of a cross-model Google Gen AI turn with the base64 bypass", () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const contents = convertMessages(model, normalizeContext(makeContext({ ...model, id: "other-model" })));

		const modelTurn = contents.find((c) => c.role === "model");
		expect(modelTurn).toBeTruthy();

		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];
		expect(functionCallParts.map((p) => p.thoughtSignature)).toEqual([SKIP_B64, undefined]);
		// Raw non-base64 sentinel broke Vertex in #4032.
		expect(JSON.stringify(modelTurn)).not.toContain("skip_thought_signature_validator");

		const textParts = modelTurn?.parts?.filter((p) => p.text !== undefined) ?? [];
		const historicalText = textParts.filter((p) => p.text?.includes("Historical context"));
		expect(historicalText).toHaveLength(0);
	});

	it("signs only the first call of an unsigned Vertex turn with the base64 bypass", () => {
		const model = makeGemini3Model("google-vertex", "google-vertex");
		const contents = convertMessages(model, normalizeContext(makeContext(model)));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];

		expect(functionCallParts.map((p) => p.thoughtSignature)).toEqual([SKIP_B64, undefined]);
	});

	// agy (Antigravity's client) replays a gemini-3.7-flash signature verbatim on gemini-3.6-flash; Vertex accepts it.
	it("keeps another Gemini model's signature from the same provider", () => {
		const model = makeGemini3Model("google-vertex", "google-vertex", "gemini-3.6-flash");
		const source = { api: "google-vertex", provider: "google-vertex", id: "gemini-3.7-flash" };
		const signature = "AY89a1AAAAAAAAAAAAAAAA==";
		const contents = convertMessages(model, normalizeContext(makeContext(source, signature)));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];

		expect(functionCallParts.map((p) => p.thoughtSignature)).toEqual([signature, undefined]);
	});

	it("does not keep a Gemini signature for a non-Gemini source model", () => {
		const model = makeGemini3Model("google-vertex", "google-vertex", "gemini-3.6-flash");
		const source = { api: "google-vertex", provider: "google-vertex", id: "gemma-4-31b-it" };
		const contents = convertMessages(model, normalizeContext(makeContext(source, "AAAAAAAAAAAAAAAAAAAAAA==")));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];

		expect(functionCallParts.map((p) => p.thoughtSignature)).toEqual([SKIP_B64, undefined]);
	});

	it("replaces a foreign provider's signature on Vertex with the bypass", () => {
		const model = makeGemini3Model("google-vertex", "google-vertex", "gemini-4-carbon");
		const foreign = { api: "google-generative-ai", provider: "antigravity", id: "gemini-4-carbon" };
		const contents = convertMessages(model, normalizeContext(makeContext(foreign, "AAAAAAAAAAAAAAAAAAAAAA==")));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];

		expect(functionCallParts.map((p) => p.thoughtSignature)).toEqual([SKIP_B64, undefined]);
	});

	it("preserves valid thoughtSignature when present for the same provider and model", () => {
		const model = makeGemini3Model("google-generative-ai", "google");
		const validSig = "AAAAAAAAAAAAAAAAAAAAAA==";
		const contents = convertMessages(model, normalizeContext(makeContext(model, validSig)));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((p) => p.functionCall !== undefined) ?? [];

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts[0]?.thoughtSignature).toBe(validSig);
		expect(functionCallParts[1]?.thoughtSignature).toBeUndefined();
	});

	it("does not add a thoughtSignature for non-Gemini-3 models", () => {
		const model = makeGemini3Model("google-generative-ai", "google", "gemini-2.5-flash");
		const contents = convertMessages(model, normalizeContext(makeContext({ ...model, id: "other-model" })));
		const modelTurn = contents.find((c) => c.role === "model");
		const functionCallParts = modelTurn?.parts?.filter((part) => part.functionCall !== undefined) ?? [];
		const functionResponseParts = contents
			.flatMap((content) => content.parts ?? [])
			.filter((part) => part.functionResponse !== undefined);

		expect(functionCallParts).toHaveLength(2);
		expect(functionCallParts.every((part) => part.functionCall?.id === undefined)).toBe(true);
		expect(functionCallParts.every((part) => part.thoughtSignature === undefined)).toBe(true);
		expect(functionResponseParts).toHaveLength(2);
		expect(functionResponseParts.every((part) => part.functionResponse?.id === undefined)).toBe(true);
	});
});

describe("requiresFunctionCallThoughtSignature", () => {
	it.each([
		[false, "gemini-2.5-flash"],
		[true, "gemini-3-flash-preview"],
		[true, "gemini-3.8-flash"],
		[true, "gemini-4-carbon"],
		[false, "claude-sonnet-4-5"],
	] as const)("returns %s for %s", (expected, modelId) => {
		expect(requiresFunctionCallThoughtSignature(modelId)).toBe(expected);
	});
});

describe("requiresToolCallId", () => {
	it.each([
		[false, "gemini-2.5-flash"],
		[true, "gemini-3.6-flash"],
		[true, "randomprefix-gemini-4-argon"], // #12321
		[false, "vendor-gemini-2.5-flash"],
		[true, "claude-sonnet-4-5"],
		[true, "gpt-oss-120b"],
	] as const)("returns %s for %s", (expected, modelId) => {
		expect(requiresToolCallId(modelId)).toBe(expected);
	});
});
