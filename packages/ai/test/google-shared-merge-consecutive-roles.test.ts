import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/providers/google-shared.js";
import type { Context, Model } from "../src/types.js";

function makeGeminiModel(id = "gemini-3-pro-preview"): Model<"google-generative-ai"> {
	return {
		id,
		name: "Gemini 3 Pro Preview",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

describe("google-shared convertMessages — merge consecutive roles", () => {
	it("merges consecutive user turns when assistant turn is skipped (empty thinking)", () => {
		const now = Date.now();
		const model = makeGeminiModel();
		const context: Context = {
			messages: [
				{ role: "user", content: "Hello", timestamp: now },
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "", thinkingSignature: undefined }],
					api: "google-generative-ai",
					provider: "google-vertex",
					model: "gemini-3-pro-preview",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: now,
				},
				{ role: "user", content: "Follow up", timestamp: now },
			],
		};

		const contents = convertMessages(model, context);

		// No consecutive same-role turns
		for (let i = 1; i < contents.length; i++) {
			expect(contents[i].role).not.toBe(contents[i - 1].role);
		}
		// Both user texts should be merged into a single user turn
		const userTurns = contents.filter((c) => c.role === "user");
		expect(userTurns).toHaveLength(1);
		expect(userTurns[0].parts).toHaveLength(2);
	});

	it("merges consecutive model turns when user turn is skipped (empty image-only for non-image model)", () => {
		const now = Date.now();
		const model = makeGeminiModel();
		const context: Context = {
			messages: [
				{ role: "user", content: "Start", timestamp: now },
				{
					role: "assistant",
					content: [{ type: "text", text: "First response" }],
					api: "google-generative-ai",
					provider: "google",
					model: "gemini-3-pro-preview",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: now,
				},
				{
					role: "user",
					content: [{ type: "image", mimeType: "image/png", data: "abc" }],
					timestamp: now,
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "Second response" }],
					api: "google-generative-ai",
					provider: "google",
					model: "gemini-3-pro-preview",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: now,
				},
			],
		};

		const contents = convertMessages(model, context);

		for (let i = 1; i < contents.length; i++) {
			expect(contents[i].role).not.toBe(contents[i - 1].role);
		}
	});

	it("does not merge when roles already alternate correctly", () => {
		const now = Date.now();
		const model = makeGeminiModel();
		const context: Context = {
			messages: [
				{ role: "user", content: "Hello", timestamp: now },
				{
					role: "assistant",
					content: [{ type: "text", text: "Hi there" }],
					api: "google-generative-ai",
					provider: "google",
					model: "gemini-3-pro-preview",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: now,
				},
				{ role: "user", content: "Thanks", timestamp: now },
			],
		};

		const contents = convertMessages(model, context);

		expect(contents).toHaveLength(3);
		expect(contents[0].role).toBe("user");
		expect(contents[1].role).toBe("model");
		expect(contents[2].role).toBe("user");
	});
});
