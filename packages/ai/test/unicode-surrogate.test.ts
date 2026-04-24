import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions, ToolResultMessage } from "../src/types.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { resolveApiKey } from "./oauth.js";

// Empty schema for test tools - must be proper OBJECT type for Cloud Code Assist
const emptySchema = Type.Object({});

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("google-gemini-cli"),
	resolveApiKey("google-antigravity"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, geminiCliToken, antigravityToken, openaiCodexToken] = oauthTokens;

/**
 * Test for Unicode surrogate pair handling in tool results.
 *
 * Issue: When tool results contain emoji or other characters outside the Basic Multilingual Plane,
 * they may be incorrectly serialized as unpaired surrogates, causing "no low surrogate in string"
 * errors when sent to the API provider.
 *
 * Example error from Anthropic:
 * "The request body is not valid JSON: no low surrogate in string: line 1 column 197667"
 */

async function testEmojiInToolResults<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const toolCallId = llm.provider === "mistral" ? "testtool1" : "test_1";
	// Simulate a tool that returns emoji
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Use the test tool",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "test_tool",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
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
			},
		],
		tools: [
			{
				name: "test_tool",
				description: "A test tool",
				parameters: emptySchema,
			},
		],
	};

	// Add tool result with various problematic Unicode characters
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId,
		toolName: "test_tool",
		content: [
			{
				type: "text",
				text: `Test with emoji 🙈 and other characters:
- Monkey emoji: 🙈
- Thumbs up: 👍
- Heart: ❤️
- Thinking face: 🤔
- Rocket: 🚀
- Mixed text: Mario Zechner wann? Wo? Bin grad äußersr eventuninformiert 🙈
- Japanese: こんにちは
- Chinese: 你好
- Mathematical symbols: ∑∫∂√
- Special quotes: "curly" 'quotes'`,
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	// Add follow-up user message
	context.messages.push({
		role: "user",
		content: "Summarize the tool result briefly.",
		timestamp: Date.now(),
	});

	// This should not throw a surrogate pair error
	const response = await complete(llm, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.length).toBeGreaterThan(0);
}

async function testRealWorldLinkedInData<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const toolCallId = llm.provider === "mistral" ? "linkedin1" : "linkedin_1";
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Use the linkedin tool to get comments",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "linkedin_skill",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
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
			},
		],
		tools: [
			{
				name: "linkedin_skill",
				description: "Get LinkedIn comments",
				parameters: emptySchema,
			},
		],
	};

	// Real-world tool result from LinkedIn with emoji
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId,
		toolName: "linkedin_skill",
		content: [
			{
				type: "text",
				text: `Post: Hab einen "Generative KI für Nicht-Techniker" Workshop gebaut.
Unanswered Comments: 2

=> {
  "comments": [
    {
      "author": "Matthias Neumayer's  graphic link",
      "text": "Leider nehmen das viel zu wenige Leute ernst"
    },
    {
      "author": "Matthias Neumayer's  graphic link",
      "text": "Mario Zechner wann? Wo? Bin grad äußersr eventuninformiert 🙈"
    }
  ]
}`,
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	context.messages.push({
		role: "user",
		content: "How many comments are there?",
		timestamp: Date.now(),
	});

	// This should not throw a surrogate pair error
	const response = await complete(llm, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.some((b) => b.type === "text")).toBe(true);
}

async function testUnpairedHighSurrogate<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const toolCallId = llm.provider === "mistral" ? "testtool2" : "test_2";
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: "Use the test tool",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "test_tool",
						arguments: {},
					},
				],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
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
			},
		],
		tools: [
			{
				name: "test_tool",
				description: "A test tool",
				parameters: emptySchema,
			},
		],
	};

	// Construct a string with an intentionally unpaired high surrogate
	// This simulates what might happen if text processing corrupts emoji
	const unpairedSurrogate = String.fromCharCode(0xd83d); // High surrogate without low surrogate

	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCallId,
		toolName: "test_tool",
		content: [{ type: "text", text: `Text with unpaired surrogate: ${unpairedSurrogate} <- should be sanitized` }],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	context.messages.push({
		role: "user",
		content: "What did the tool return?",
		timestamp: Date.now(),
	});

	// This should not throw a surrogate pair error
	// The unpaired surrogate should be sanitized before sending to API
	const response = await complete(llm, context, options);

	expect(response.stopReason).not.toBe("error");
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.length).toBeGreaterThan(0);
}

describe("AI Providers Unicode Surrogate Pair Tests", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider Unicode Handling", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider Unicode Handling", () => {
		const llm = getModel("openai", "gpt-4o-mini");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider Unicode Handling", () => {
		const llm = getModel("openai", "gpt-5-mini");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider Unicode Handling", () => {
		const llm = getModel("azure-openai-responses", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm, azureOptions);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm, azureOptions);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm, azureOptions);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider Unicode Handling", () => {
		const llm = getModel("anthropic", "claude-haiku-4-5");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	// =========================================================================
	// OAuth-based providers (credentials from ~/.pi/agent/oauth.json)
	// =========================================================================

	describe("Anthropic OAuth Provider Unicode Handling", () => {
		const llm = getModel("anthropic", "claude-haiku-4-5");

		it.skipIf(!anthropicOAuthToken)("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)(
			"should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testRealWorldLinkedInData(llm, { apiKey: anthropicOAuthToken });
			},
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testUnpairedHighSurrogate(llm, { apiKey: anthropicOAuthToken });
			},
		);
	});

	describe("GitHub Copilot Provider Unicode Handling", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should handle emoji in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-4o");
				await testEmojiInToolResults(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-4o");
				await testRealWorldLinkedInData(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-4o");
				await testUnpairedHighSurrogate(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle emoji in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4");
				await testEmojiInToolResults(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4");
				await testRealWorldLinkedInData(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4");
				await testUnpairedHighSurrogate(llm, { apiKey: githubCopilotToken });
			},
		);
	});

	describe("Google Gemini CLI Provider Unicode Handling", () => {
		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should handle emoji in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-gemini-cli", "gemini-2.5-flash");
				await testEmojiInToolResults(llm, { apiKey: geminiCliToken });
			},
		);

		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-gemini-cli", "gemini-2.5-flash");
				await testRealWorldLinkedInData(llm, { apiKey: geminiCliToken });
			},
		);

		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-gemini-cli", "gemini-2.5-flash");
				await testUnpairedHighSurrogate(llm, { apiKey: geminiCliToken });
			},
		);
	});

	describe("Google Antigravity Provider Unicode Handling", () => {
		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should handle emoji in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gemini-3-flash");
				await testEmojiInToolResults(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gemini-3-flash");
				await testRealWorldLinkedInData(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gemini-3-flash");
				await testUnpairedHighSurrogate(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should handle emoji in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "claude-sonnet-4-5");
				await testEmojiInToolResults(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "claude-sonnet-4-5");
				await testRealWorldLinkedInData(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "claude-sonnet-4-5");
				await testUnpairedHighSurrogate(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"gpt-oss-120b-medium - should handle emoji in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gpt-oss-120b-medium");
				await testEmojiInToolResults(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"gpt-oss-120b-medium - should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gpt-oss-120b-medium");
				await testRealWorldLinkedInData(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"gpt-oss-120b-medium - should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gpt-oss-120b-medium");
				await testUnpairedHighSurrogate(llm, { apiKey: antigravityToken });
			},
		);
	});

	describe.skipIf(!process.env.XAI_API_KEY)("xAI Provider Unicode Handling", () => {
		const llm = getModel("xai", "grok-3");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq Provider Unicode Handling", () => {
		const llm = getModel("groq", "openai/gpt-oss-20b");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras Provider Unicode Handling", () => {
		const llm = getModel("cerebras", "gpt-oss-120b");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.HF_TOKEN)("Hugging Face Provider Unicode Handling", () => {
		const llm = getModel("huggingface", "moonshotai/Kimi-K2.5");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.ZAI_API_KEY)("zAI Provider Unicode Handling", () => {
		const llm = getModel("zai", "glm-4.5-air");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider Unicode Handling", () => {
		const llm = getModel("mistral", "devstral-medium-latest");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax Provider Unicode Handling", () => {
		const llm = getModel("minimax", "MiniMax-M2.7");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider Unicode Handling", () => {
		const llm = getModel("kimi-coding", "kimi-k2-thinking");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway Provider Unicode Handling", () => {
		const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider Unicode Handling", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should handle emoji in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testEmojiInToolResults(llm);
		});

		it("should handle real-world LinkedIn comment data with emoji", { retry: 3, timeout: 30000 }, async () => {
			await testRealWorldLinkedInData(llm);
		});

		it("should handle unpaired high surrogate (0xD83D) in tool results", { retry: 3, timeout: 30000 }, async () => {
			await testUnpairedHighSurrogate(llm);
		});
	});

	describe("OpenAI Codex Provider Unicode Handling", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle emoji in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await testEmojiInToolResults(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle real-world LinkedIn comment data with emoji",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await testRealWorldLinkedInData(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle unpaired high surrogate (0xD83D) in tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await testUnpairedHighSurrogate(llm, { apiKey: openaiCodexToken });
			},
		);
	});
});
