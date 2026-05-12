import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions, Tool } from "../src/types.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { hasCloudflareAiGatewayCredentials, hasCloudflareWorkersAICredentials } from "./cloudflare-utils.js";
import { resolveApiKey } from "./oauth.js";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

// Simple calculate tool
const calculateSchema = Type.Object({
	expression: Type.String({ description: "The mathematical expression to evaluate" }),
});

const calculateTool: Tool = {
	name: "calculate",
	description: "Evaluate mathematical expressions",
	parameters: calculateSchema,
};

async function testToolCallWithoutResult<TApi extends Api>(model: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Step 1: Create context with the calculate tool
	const context: Context = {
		systemPrompt: "You are a helpful assistant. Use the calculate tool when asked to perform calculations.",
		messages: [],
		tools: [calculateTool],
	};

	// Step 2: Ask the LLM to make a tool call
	context.messages.push({
		role: "user",
		content: "Please calculate 25 * 18 using the calculate tool.",
		timestamp: Date.now(),
	});

	// Step 3: Get the assistant's response (should contain a tool call)
	const firstResponse = await complete(model, context, options);
	context.messages.push(firstResponse);

	console.log("First response:", JSON.stringify(firstResponse, null, 2));

	// Verify the response contains a tool call
	const hasToolCall = firstResponse.content.some((block) => block.type === "toolCall");
	expect(hasToolCall).toBe(true);

	if (!hasToolCall) {
		throw new Error("Expected assistant to make a tool call, but none was found");
	}

	// Step 4: Send a user message WITHOUT providing tool result
	// This simulates the scenario where a tool call was aborted/cancelled
	context.messages.push({
		role: "user",
		content: "Never mind, just tell me what is 2+2?",
		timestamp: Date.now(),
	});

	// Step 5: The fix should filter out the orphaned tool call, and the request should succeed
	const secondResponse = await complete(model, context, options);
	console.log("Second response:", JSON.stringify(secondResponse, null, 2));

	// The request should succeed (not error) - that's the main thing we're testing
	expect(secondResponse.stopReason).not.toBe("error");

	// Should have some content in the response
	expect(secondResponse.content.length).toBeGreaterThan(0);

	// The LLM may choose to answer directly or make a new tool call - either is fine
	// The important thing is it didn't fail with the orphaned tool call error
	const textContent = secondResponse.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join(" ");
	const toolCalls = secondResponse.content.filter((block) => block.type === "toolCall").length;
	expect(toolCalls || textContent.length).toBeGreaterThan(0);
	console.log("Answer:", textContent);

	// Verify the stop reason is either "stop" or "toolUse" (new tool call)
	expect(["stop", "toolUse"]).toContain(secondResponse.stopReason);
}

describe("Tool Call Without Result Tests", () => {
	// =========================================================================
	// API Key-based providers
	// =========================================================================

	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider", () => {
		const model = getModel("google", "gemini-2.5-flash");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		void _compat;
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider", () => {
		const model = getModel("openai", "gpt-5-mini");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider", () => {
		const model = getModel("azure-openai-responses", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(model.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model, azureOptions);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider", () => {
		const model = getModel("anthropic", "claude-haiku-4-5");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.XAI_API_KEY)("xAI Provider", () => {
		const model = getModel("xai", "grok-3-fast");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq Provider", () => {
		const model = getModel("groq", "openai/gpt-oss-20b");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras Provider", () => {
		const model = getModel("cerebras", "gpt-oss-120b");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!hasCloudflareWorkersAICredentials())("Cloudflare Workers AI Provider", () => {
		const model = getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!hasCloudflareAiGatewayCredentials())("Cloudflare AI Gateway Provider", () => {
		const model = getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.HF_TOKEN)("Hugging Face Provider", () => {
		const model = getModel("huggingface", "moonshotai/Kimi-K2.5");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.ZAI_API_KEY)("zAI Provider", () => {
		const model = getModel("zai", "glm-4.5-air");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider", () => {
		const model = getModel("mistral", "devstral-medium-latest");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax Provider", () => {
		const model = getModel("minimax", "MiniMax-M2.7");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.XIAOMI_API_KEY)("Xiaomi MiMo (API billing) Provider", () => {
		const model = getModel("xiaomi", "mimo-v2.5-pro");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY)("Xiaomi MiMo Token Plan (CN) Provider", () => {
		const model = getModel("xiaomi-token-plan-cn", "mimo-v2.5-pro");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY)("Xiaomi MiMo Token Plan (AMS) Provider", () => {
		const model = getModel("xiaomi-token-plan-ams", "mimo-v2.5-pro");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY)("Xiaomi MiMo Token Plan (SGP) Provider", () => {
		const model = getModel("xiaomi-token-plan-sgp", "mimo-v2.5-pro");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider", () => {
		const model = getModel("kimi-coding", "kimi-k2-thinking");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway Provider", () => {
		const model = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider", () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should filter out tool calls without corresponding tool results", { retry: 3, timeout: 30000 }, async () => {
			await testToolCallWithoutResult(model);
		});
	});

	// =========================================================================
	// OAuth-based providers (credentials from ~/.pi/agent/oauth.json)
	// =========================================================================

	describe("Anthropic OAuth Provider", () => {
		const model = getModel("anthropic", "claude-haiku-4-5");

		it.skipIf(!anthropicOAuthToken)(
			"should filter out tool calls without corresponding tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testToolCallWithoutResult(model, { apiKey: anthropicOAuthToken });
			},
		);
	});

	describe("GitHub Copilot Provider", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should filter out tool calls without corresponding tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const model = getModel("github-copilot", "gpt-4o");
				await testToolCallWithoutResult(model, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should filter out tool calls without corresponding tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const model = getModel("github-copilot", "claude-sonnet-4.5");
				await testToolCallWithoutResult(model, { apiKey: githubCopilotToken });
			},
		);
	});

	describe("OpenAI Codex Provider", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should filter out tool calls without corresponding tool results",
			{ retry: 3, timeout: 30000 },
			async () => {
				const model = getModel("openai-codex", "gpt-5.2-codex");
				await testToolCallWithoutResult(model, { apiKey: openaiCodexToken });
			},
		);
	});
});
