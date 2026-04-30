import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/providers/google-shared.js";
import type { Context, Model } from "../src/types.js";

function makeModel<TApi extends "google-generative-ai">(
	api: TApi,
	provider: Model<TApi>["provider"],
	id: string,
): Model<TApi> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function makeContext(model: { api: string; provider: string; id: string }): Context {
	const now = Date.now();
	return {
		messages: [
			{ role: "user", content: "read the files", timestamp: now },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a.txt" } },
					{ type: "toolCall", id: "call_img", name: "read", arguments: { path: "image.png" } },
					{ type: "toolCall", id: "call_b", name: "read", arguments: { path: "b.txt" } },
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
				toolCallId: "call_a",
				toolName: "read",
				content: [{ type: "text", text: "alpha text" }],
				isError: false,
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: "call_img",
				toolName: "read",
				content: [{ type: "image", data: "abc", mimeType: "image/png" }],
				isError: false,
				timestamp: now,
			},
			{
				role: "toolResult",
				toolCallId: "call_b",
				toolName: "read",
				content: [{ type: "text", text: "beta text" }],
				isError: false,
				timestamp: now,
			},
		],
	};
}

describe("google-shared image tool result routing", () => {
	it("keeps separate synthetic image turn for Gemini 2.x Google API models", () => {
		const model = makeModel("google-generative-ai", "google", "gemini-2.5-flash");
		const contents = convertMessages(model, makeContext(model));

		expect(contents).toHaveLength(5);
		expect(contents[2].parts?.every((part) => part.functionResponse)).toBe(true);
		expect(contents[3].parts?.[0]?.text).toBe("Tool result image:");
		expect(contents[3].parts?.[1]?.inlineData).toBeTruthy();
		expect(contents[4].parts?.[0]?.functionResponse).toBeTruthy();
	});

	it("nests image tool results for Gemini 3 Google API models", () => {
		const model = makeModel("google-generative-ai", "google", "gemini-3-pro-preview");
		const contents = convertMessages(model, makeContext(model));

		expect(contents).toHaveLength(3);
		const toolResultTurn = contents[2];
		expect(toolResultTurn.parts).toHaveLength(3);
		const imageResponse = toolResultTurn.parts?.[1]?.functionResponse;
		expect(imageResponse).toBeTruthy();
		expect(imageResponse?.parts).toHaveLength(1);
		expect(imageResponse?.parts?.[0]?.inlineData).toBeTruthy();
	});
});
