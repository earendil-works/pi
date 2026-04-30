import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/providers/google-shared.js";
import type { Context, Model } from "../src/types.js";

const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

function makeGemini3Model(id = "gemini-3-pro-preview"): Model<"google-generative-ai"> {
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

describe("google-shared convertMessages — Gemini 3 unsigned tool calls", () => {
	it("uses skip_thought_signature_validator for unsigned tool calls on Gemini 3", () => {
		const model = makeGemini3Model();
		const now = Date.now();
		const context: Context = {
			messages: [
				{ role: "user", content: "Hi", timestamp: now },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_1",
							name: "bash",
							arguments: { command: "ls -la" },
							// No thoughtSignature: simulates Claude via Antigravity.
						},
					],
					api: "google-gemini-cli",
					provider: "google-antigravity",
					model: "claude-sonnet-4-6",
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

		const modelTurn = contents.find((c) => c.role === "model");
		expect(modelTurn).toBeTruthy();

		// Should be a structured functionCall, NOT text fallback
		const fcPart = modelTurn?.parts?.find((p) => p.functionCall !== undefined);
		expect(fcPart).toBeTruthy();
		expect(fcPart?.functionCall?.name).toBe("bash");
		expect(fcPart?.functionCall?.args).toEqual({ command: "ls -la" });
		expect(fcPart?.thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE);

		// No text fallback should exist
		const textParts = modelTurn?.parts?.filter((p) => p.text !== undefined) ?? [];
		const historicalText = textParts.filter((p) => p.text?.includes("Historical context"));
		expect(historicalText).toHaveLength(0);
	});

	it("preserves valid thoughtSignature when present (same provider/model)", () => {
		const model = makeGemini3Model();
		const now = Date.now();
		// Valid base64 signature (16 bytes = 24 chars base64)
		const validSig = "AAAAAAAAAAAAAAAAAAAAAA==";
		const context: Context = {
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
							thoughtSignature: validSig,
						},
					],
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
		const modelTurn = contents.find((c) => c.role === "model");
		const fcPart = modelTurn?.parts?.find((p) => p.functionCall !== undefined);

		expect(fcPart).toBeTruthy();
		expect(fcPart?.thoughtSignature).toBe(validSig);
	});

	it("does not add sentinel for non-Gemini-3 models", () => {
		const model: Model<"google-generative-ai"> = {
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://generativelanguage.googleapis.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const now = Date.now();
		const context: Context = {
			messages: [
				{ role: "user", content: "Hi", timestamp: now },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_1",
							name: "bash",
							arguments: { command: "ls" },
							// No thoughtSignature
						},
					],
					api: "google-gemini-cli",
					provider: "google-antigravity",
					model: "claude-sonnet-4-6",
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
		const modelTurn = contents.find((c) => c.role === "model");
		const fcPart = modelTurn?.parts?.find((p) => p.functionCall !== undefined);

		expect(fcPart).toBeTruthy();
		// No sentinel, no thoughtSignature at all
		expect(fcPart?.thoughtSignature).toBeUndefined();
	});
});
