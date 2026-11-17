import { describe, expect, it } from "vitest";
import { convertMessages, requiresFunctionCallThoughtSignature, requiresToolCallId } from "../src/api/google-shared.ts";
import type { Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const OMITTED_CALL = "[Earlier tool call omitted because its signature is unavailable.]";
const HISTORY_NOTE =
	'[History note: Earlier "[Observation from ...]" blocks are historical tool results, not a format to imitate. To use a tool now, emit a real functionCall.]';
// What a turn without a usable signature becomes: the calls are dropped and their results are user text.
const OBSERVED_CONTENTS = [
	{ role: "user", parts: [{ text: "Hi" }] },
	{ role: "model", parts: [{ text: OMITTED_CALL }] },
	{
		role: "user",
		parts: [
			{ text: '[Observation from `bash` ({"command":"echo hi"}):\nhi]' },
			{ text: '[Observation from `bash` ({"command":"ls -la"}):\nfiles]' },
			{ text: HISTORY_NOTE },
		],
	},
];

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
	])("preserves tool call IDs for signed $id via $api history", (model) => {
		const context = makeContext(model, "AAAAAAAAAAAAAAAAAAAAAA==");
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

	// Live 2026-11-17, gemini-4-hydrogen (Vertex and AI Studio), snoop cap_01a1e9f9-3c22-7123-8b55-4adff028a8d5:
	// history replayed as functionCall parts with the skip_thought_signature_validator bypass made the next
	// response end in MALFORMED_RESPONSE (the call is written into the thinking and an empty call is emitted)
	// or return a call with a placeholder signature and no thought. The same history as observations: STOP
	// with a thought and a real signature, every time.
	it.each([
		["another model on Google Gen AI", makeGemini3Model("google-generative-ai", "google"), undefined],
		["an unsigned Vertex turn", makeGemini3Model("google-vertex", "google-vertex"), undefined],
		[
			"gemini-4-hydrogen on Vertex",
			makeGemini3Model("google-vertex", "google-vertex", "gemini-4-hydrogen"),
			undefined,
		],
		[
			"a non-Gemini source model's signature",
			makeGemini3Model("google-vertex", "google-vertex", "gemini-3.6-flash"),
			{ api: "google-vertex", provider: "google-vertex", id: "gemma-4-31b-it" },
		],
		[
			"a foreign provider's signature",
			makeGemini3Model("google-vertex", "google-vertex", "gemini-4-carbon"),
			{ api: "google-generative-ai", provider: "antigravity", id: "gemini-4-carbon" },
		],
	] as const)("replays %s as observations, not function calls", (_name, model, source) => {
		const context = source
			? makeContext(source, "AAAAAAAAAAAAAAAAAAAAAA==")
			: makeContext({ ...model, id: model.id === "gemini-4-hydrogen" ? "claude-opus-4-5" : "other-model" });
		const contents = convertMessages(model, normalizeContext(context));

		expect(contents).toEqual(OBSERVED_CONTENTS);
		// No bypass signature in any form: raw (broke Vertex in #4032) or base64.
		expect(JSON.stringify(contents)).not.toContain("skip_thought_signature_validator");
		expect(JSON.stringify(contents)).not.toContain("c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=");
	});

	it("keeps the text of an unsigned turn and drops only its calls", () => {
		const model = makeGemini3Model("google-vertex", "google-vertex", "gemini-4-hydrogen");
		const context = makeContext({ api: "anthropic-messages", provider: "anthropic", id: "claude-opus-4-5" });
		const assistant = context.messages[1];
		if (assistant.role !== "assistant") throw new Error("expected the assistant turn");
		assistant.content.unshift({ type: "text", text: "Checking the tree." });
		const contents = convertMessages(model, normalizeContext(context));

		expect(contents[1]).toEqual({ role: "model", parts: [{ text: "Checking the tree." }] });
		expect(contents[2]).toEqual(OBSERVED_CONTENTS[2]);
	});

	it("labels an observation without arguments by tool name only and keeps images after it", () => {
		const model = {
			...makeGemini3Model("google-vertex", "google-vertex", "gemini-4-hydrogen"),
			input: ["text", "image"],
		};
		const now = Date.now();
		const context: Context = {
			messages: [
				{ role: "user", content: "Hi", timestamp: now },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "screenshot", arguments: {} }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-opus-4-5",
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
					toolName: "screenshot",
					content: [{ type: "image", mimeType: "image/png", data: "aGk=" }],
					isError: false,
					timestamp: now,
				},
				{ role: "user", content: "What is on it?", timestamp: now },
			],
		};
		const contents = convertMessages(model as Model<"google-vertex">, normalizeContext(context));

		expect(contents.slice(2)).toEqual([
			{
				role: "user",
				parts: [
					{ text: "[Observation from `screenshot`:\n(see attached image)]" },
					{ inlineData: { mimeType: "image/png", data: "aGk=" } },
					{ text: HISTORY_NOTE },
				],
			},
			{ role: "user", parts: [{ text: "What is on it?" }] },
		]);
	});

	// Live Vertex 2026-11-17: a text part after functionResponse parts in one user turn -> 400 "Requests
	// ending with a model turn are not supported", so the note stays with the observations.
	it("keeps signed turns as function calls next to observed ones and puts the note in the last observation turn", () => {
		const model = makeGemini3Model("google-vertex", "google-vertex", "gemini-4-hydrogen");
		const foreign = makeContext({ api: "anthropic-messages", provider: "anthropic", id: "claude-opus-4-5" });
		const own = makeContext(model, "AAAAAAAAAAAAAAAAAAAAAA==");
		const contents = convertMessages(model, normalizeContext({ messages: [...foreign.messages, ...own.messages] }));

		expect(contents.slice(0, 3)).toEqual(OBSERVED_CONTENTS);
		expect(contents[4].parts?.map((part) => part.functionCall?.id)).toEqual(["call_1", "call_2"]);
		expect(contents[4].parts?.map((part) => part.thoughtSignature)).toEqual(["AAAAAAAAAAAAAAAAAAAAAA==", undefined]);
		expect(contents[5].parts?.map((part) => part.functionResponse?.id ?? part.text)).toEqual(["call_1", "call_2"]);
		expect(JSON.stringify(contents).split(HISTORY_NOTE.slice(0, 20)).length - 1).toBe(1);
	});

	it("adds no history note when every turn is replayed as function calls", () => {
		const model = makeGemini3Model("google-vertex", "google-vertex");
		const contents = convertMessages(model, normalizeContext(makeContext(model, "AAAAAAAAAAAAAAAAAAAAAA==")));

		expect(JSON.stringify(contents)).not.toContain("History note");
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

	it("replays unsigned calls as function calls for non-Gemini-3 models", () => {
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
		expect(JSON.stringify(contents)).not.toContain("Observation from");
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
