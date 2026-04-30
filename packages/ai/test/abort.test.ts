import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete, stream } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions } from "../src/types.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { resolveApiKey } from "./oauth.js";

// Resolve OAuth tokens at module level (async, runs before tests)
const [openaiCodexToken] = await Promise.all([resolveApiKey("openai-codex")]);

async function testAbortSignal<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "What is 15 + 27? Think step by step. Then list 50 first names.",
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	let abortFired = false;
	let text = "";
	const controller = new AbortController();
	const response = await stream(llm, context, { ...options, signal: controller.signal });
	for await (const event of response) {
		if (abortFired) return;
		if (event.type === "text_delta" || event.type === "thinking_delta") {
			text += event.delta;
		}
		if (text.length >= 50) {
			controller.abort();
			abortFired = true;
		}
	}
	const msg = await response.result();

	// If we get here without throwing, the abort didn't work
	expect(msg.stopReason).toBe("aborted");
	expect(msg.content.length).toBeGreaterThan(0);

	context.messages.push(msg);
	context.messages.push({
		role: "user",
		content: "Please continue, but only generate 5 names.",
		timestamp: Date.now(),
	});

	const followUp = await complete(llm, context, options);
	expect(followUp.stopReason).toBe("stop");
	expect(followUp.content.length).toBeGreaterThan(0);
}

async function testImmediateAbort<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const controller = new AbortController();

	controller.abort();

	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	const response = await complete(llm, context, { ...options, signal: controller.signal });
	expect(response.stopReason).toBe("aborted");
}

async function testAbortThenNewMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// First request: abort immediately before any response content arrives
	const controller = new AbortController();
	controller.abort();

	const context: Context = {
		messages: [{ role: "user", content: "Hello, how are you?", timestamp: Date.now() }],
	};

	const abortedResponse = await complete(llm, context, { ...options, signal: controller.signal });
	expect(abortedResponse.stopReason).toBe("aborted");
	// The aborted message has empty content since we aborted before anything arrived
	expect(abortedResponse.content.length).toBe(0);

	// Add the aborted assistant message to context (this is what happens in the real coding agent)
	context.messages.push(abortedResponse);

	// Second request: send a new message - this should work even with the aborted message in context
	context.messages.push({
		role: "user",
		content: "What is 2 + 2?",
		timestamp: Date.now(),
	});

	const followUp = await complete(llm, context, options);
	expect(followUp.stopReason).toBe("stop");
	expect(followUp.content.length).toBeGreaterThan(0);
}

describe("AI Providers Abort Tests", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider Abort", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm, { thinking: { enabled: true } });
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm, { thinking: { enabled: true } });
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider Abort", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		void _compat;
		const llm: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm);
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider Abort", () => {
		const llm = getModel("openai", "gpt-5-mini");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm);
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider Abort", () => {
		const llm = getModel("azure-openai-responses", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm, azureOptions);
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm, azureOptions);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_OAUTH_TOKEN)("Anthropic Provider Abort", () => {
		const llm = getModel("anthropic", "claude-opus-4-1-20250805");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider Abort", () => {
		const llm = getModel("mistral", "devstral-medium-latest");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm);
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm);
		});
	});

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax Provider Abort", () => {
		const llm = getModel("minimax", "MiniMax-M2.7");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm);
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm);
		});
	});

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider Abort", () => {
		const llm = getModel("kimi-coding", "kimi-k2-thinking");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm);
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm);
		});
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway Provider Abort", () => {
		const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm);
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm);
		});
	});

	describe("OpenAI Codex Provider Abort", () => {
		it.skipIf(!openaiCodexToken)("should abort mid-stream", { retry: 3 }, async () => {
			const llm = getModel("openai-codex", "gpt-5.2-codex");
			await testAbortSignal(llm, { apiKey: openaiCodexToken });
		});

		it.skipIf(!openaiCodexToken)("should handle immediate abort", { retry: 3 }, async () => {
			const llm = getModel("openai-codex", "gpt-5.2-codex");
			await testImmediateAbort(llm, { apiKey: openaiCodexToken });
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider Abort", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should abort mid-stream", { retry: 3 }, async () => {
			await testAbortSignal(llm, { reasoning: "medium" });
		});

		it("should handle immediate abort", { retry: 3 }, async () => {
			await testImmediateAbort(llm);
		});

		it("should handle abort then new message", { retry: 3 }, async () => {
			await testAbortThenNewMessage(llm);
		});
	});
});
