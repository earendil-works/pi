/**
 * Test totalTokens field across all providers.
 *
 * totalTokens represents the total number of tokens processed by the LLM,
 * including input (with cache) and output (with thinking). This is the
 * base for calculating context size for the next request.
 *
 * - OpenAI Completions: Uses native total_tokens field
 * - OpenAI Responses: Uses native total_tokens field
 * - Google: Uses native totalTokenCount field
 * - Anthropic: Computed as input + output + cacheRead + cacheWrite
 * - Other OpenAI-compatible providers: Uses native total_tokens field
 */

import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions, Usage } from "../src/types.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { resolveApiKey } from "./oauth.js";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("google-gemini-cli"),
	resolveApiKey("google-antigravity"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, geminiCliToken, antigravityToken, openaiCodexToken] = oauthTokens;

// Generate a long system prompt to trigger caching (>2k bytes for most providers)
const LONG_SYSTEM_PROMPT = `You are a helpful assistant. Be concise in your responses.

Here is some additional context that makes this system prompt long enough to trigger caching:

${Array(50)
	.fill(
		"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
	)
	.join("\n\n")}

Remember: Always be helpful and concise.`;

async function testTotalTokensWithCache<TApi extends Api>(
	llm: Model<TApi>,
	options: StreamOptionsWithExtras = {},
): Promise<{ first: Usage; second: Usage }> {
	// First request - no cache
	const context1: Context = {
		systemPrompt: LONG_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: "What is 2 + 2? Reply with just the number.",
				timestamp: Date.now(),
			},
		],
	};

	const response1 = await complete(llm, context1, options);
	expect(response1.stopReason).toBe("stop");

	// Second request - should trigger cache read (same system prompt, add conversation)
	const context2: Context = {
		systemPrompt: LONG_SYSTEM_PROMPT,
		messages: [
			...context1.messages,
			response1, // Include previous assistant response
			{
				role: "user",
				content: "What is 3 + 3? Reply with just the number.",
				timestamp: Date.now(),
			},
		],
	};

	const response2 = await complete(llm, context2, options);
	expect(response2.stopReason).toBe("stop");

	return { first: response1.usage, second: response2.usage };
}

function logUsage(label: string, usage: Usage) {
	const computed = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	console.log(`  ${label}:`);
	console.log(
		`    input: ${usage.input}, output: ${usage.output}, cacheRead: ${usage.cacheRead}, cacheWrite: ${usage.cacheWrite}`,
	);
	console.log(`    totalTokens: ${usage.totalTokens}, computed: ${computed}`);
}

function assertTotalTokensEqualsComponents(usage: Usage) {
	const computed = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	expect(usage.totalTokens).toBe(computed);
}

describe("totalTokens field", () => {
	// =========================================================================
	// Anthropic
	// =========================================================================

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic (API Key)", () => {
		it(
			"claude-3-5-haiku - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("anthropic", "claude-3-5-haiku-20241022");

				console.log(`\nAnthropic / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.ANTHROPIC_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);

				// Anthropic should have cache activity
				const hasCache = second.cacheRead > 0 || second.cacheWrite > 0 || first.cacheWrite > 0;
				expect(hasCache).toBe(true);
			},
		);
	});

	describe("Anthropic (OAuth)", () => {
		it.skipIf(!anthropicOAuthToken)(
			"claude-sonnet-4 - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("anthropic", "claude-sonnet-4-20250514");

				console.log(`\nAnthropic OAuth / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: anthropicOAuthToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);

				// Anthropic should have cache activity
				const hasCache = second.cacheRead > 0 || second.cacheWrite > 0 || first.cacheWrite > 0;
				expect(hasCache).toBe(true);
			},
		);
	});

	// =========================================================================
	// OpenAI
	// =========================================================================

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions", () => {
		it(
			"gpt-4o-mini - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
				void _compat;
				const llm: Model<"openai-completions"> = {
					...baseModel,
					api: "openai-completions",
				};

				console.log(`\nOpenAI Completions / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm);

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses", () => {
		it("gpt-4o - should return totalTokens equal to sum of components", { retry: 3, timeout: 60000 }, async () => {
			const llm = getModel("openai", "gpt-4o");

			console.log(`\nOpenAI Responses / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm);

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses", () => {
		it(
			"gpt-4o-mini - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("azure-openai-responses", "gpt-4o-mini");
				const azureDeploymentName = resolveAzureDeploymentName(llm.id);
				const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

				console.log(`\nAzure OpenAI Responses / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, azureOptions);

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// =========================================================================
	// Google
	// =========================================================================

	describe.skipIf(!process.env.GEMINI_API_KEY)("Google", () => {
		it(
			"gemini-2.0-flash - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("google", "gemini-2.0-flash");

				console.log(`\nGoogle / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm);

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// =========================================================================
	// xAI
	// =========================================================================

	describe.skipIf(!process.env.XAI_API_KEY)("xAI", () => {
		it(
			"grok-3-fast - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("xai", "grok-3-fast");

				console.log(`\nxAI / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.XAI_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// =========================================================================
	// Groq
	// =========================================================================

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq", () => {
		it(
			"openai/gpt-oss-120b - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("groq", "openai/gpt-oss-120b");

				console.log(`\nGroq / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.GROQ_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// =========================================================================
	// Cerebras
	// =========================================================================

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras", () => {
		it(
			"gpt-oss-120b - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("cerebras", "gpt-oss-120b");

				console.log(`\nCerebras / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.CEREBRAS_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// =========================================================================
	// Hugging Face
	// =========================================================================

	describe.skipIf(!process.env.HF_TOKEN)("Hugging Face", () => {
		it("Kimi-K2.5 - should return totalTokens equal to sum of components", { retry: 3, timeout: 60000 }, async () => {
			const llm = getModel("huggingface", "moonshotai/Kimi-K2.5");

			console.log(`\nHugging Face / ${llm.id}:`);
			const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.HF_TOKEN });

			logUsage("First request", first);
			logUsage("Second request", second);

			assertTotalTokensEqualsComponents(first);
			assertTotalTokensEqualsComponents(second);
		});
	});

	// =========================================================================
	// z.ai
	// =========================================================================

	describe.skipIf(!process.env.ZAI_API_KEY)("z.ai", () => {
		it(
			"glm-4.5-flash - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("zai", "glm-4.5-flash");

				console.log(`\nz.ai / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.ZAI_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// =========================================================================
	// Mistral
	// =========================================================================

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral", () => {
		it(
			"devstral-medium-latest - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("mistral", "devstral-medium-latest");

				console.log(`\nMistral / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.MISTRAL_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// =========================================================================
	// MiniMax
	// =========================================================================

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax", () => {
		it(
			"MiniMax-M2.7 - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("minimax", "MiniMax-M2.7");

				console.log(`\nMiniMax / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.MINIMAX_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// =========================================================================
	// Kimi For Coding
	// =========================================================================

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding", () => {
		it(
			"kimi-k2-thinking - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("kimi-coding", "kimi-k2-thinking");

				console.log(`\nKimi For Coding / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.KIMI_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// =========================================================================
	// Vercel AI Gateway
	// =========================================================================

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway", () => {
		it(
			"google/gemini-2.5-flash - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

				console.log(`\nVercel AI Gateway / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.AI_GATEWAY_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// =========================================================================
	// OpenRouter - Multiple backend providers
	// =========================================================================

	describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouter", () => {
		it(
			"anthropic/claude-sonnet-4 - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("openrouter", "anthropic/claude-sonnet-4");

				console.log(`\nOpenRouter / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.OPENROUTER_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);

		it(
			"deepseek/deepseek-chat - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("openrouter", "deepseek/deepseek-chat");

				console.log(`\nOpenRouter / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.OPENROUTER_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);

		it(
			"mistralai/mistral-small-3.2-24b-instruct - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("openrouter", "mistralai/mistral-small-3.2-24b-instruct");

				console.log(`\nOpenRouter / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.OPENROUTER_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);

		it(
			"google/gemini-2.0-flash-001 - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("openrouter", "google/gemini-2.0-flash-001");

				console.log(`\nOpenRouter / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.OPENROUTER_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);

		it(
			"meta-llama/llama-4-maverick - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("openrouter", "meta-llama/llama-4-maverick");

				console.log(`\nOpenRouter / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: process.env.OPENROUTER_API_KEY });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// =========================================================================
	// GitHub Copilot (OAuth)
	// =========================================================================

	describe("GitHub Copilot (OAuth)", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-4o");

				console.log(`\nGitHub Copilot / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: githubCopilotToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4");

				console.log(`\nGitHub Copilot / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: githubCopilotToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// =========================================================================
	// Google Gemini CLI (OAuth)
	// =========================================================================

	describe("Google Gemini CLI (OAuth)", () => {
		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("google-gemini-cli", "gemini-2.5-flash");

				console.log(`\nGoogle Gemini CLI / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: geminiCliToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// =========================================================================
	// Google Antigravity (OAuth)
	// =========================================================================

	describe("Google Antigravity (OAuth)", () => {
		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("google-antigravity", "gemini-3-flash");

				console.log(`\nGoogle Antigravity / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: antigravityToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);

		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("google-antigravity", "claude-sonnet-4-5");

				console.log(`\nGoogle Antigravity / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: antigravityToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);

		it.skipIf(!antigravityToken)(
			"gpt-oss-120b-medium - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("google-antigravity", "gpt-oss-120b-medium");

				console.log(`\nGoogle Antigravity / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: antigravityToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock", () => {
		it(
			"claude-sonnet-4-5 - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

				console.log(`\nAmazon Bedrock / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm);

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});

	// =========================================================================
	// OpenAI Codex (OAuth)
	// =========================================================================

	describe("OpenAI Codex (OAuth)", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should return totalTokens equal to sum of components",
			{ retry: 3, timeout: 60000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");

				console.log(`\nOpenAI Codex / ${llm.id}:`);
				const { first, second } = await testTotalTokensWithCache(llm, { apiKey: openaiCodexToken });

				logUsage("First request", first);
				logUsage("Second request", second);

				assertTotalTokensEqualsComponents(first);
				assertTotalTokensEqualsComponents(second);
			},
		);
	});
});
