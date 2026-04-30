import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { Api, AssistantMessage, Context, Model, StreamOptions, UserMessage } from "../src/types.js";

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

async function testEmptyMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with completely empty content array
	const emptyMessage: UserMessage = {
		role: "user",
		content: [],
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [emptyMessage],
	};

	const response = await complete(llm, context, options);

	// Should either handle gracefully or return an error
	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	// Should handle empty string gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyStringMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with empty string content
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle empty string gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testWhitespaceOnlyMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with whitespace-only content
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "   \n\t  ",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle whitespace-only gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyAssistantMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with empty assistant message in conversation flow
	// User -> Empty Assistant -> User
	const emptyAssistant: AssistantMessage = {
		role: "assistant",
		content: [],
		api: llm.api,
		provider: llm.provider,
		model: llm.id,
		usage: {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Hello, how are you?",
				timestamp: Date.now(),
			},
			emptyAssistant,
			{
				role: "user",
				content: "Please respond this time.",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle empty assistant message in context gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
		expect(response.content.length).toBeGreaterThan(0);
	}
}

describe("AI Providers Empty Message Tests", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider Empty Messages", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider Empty Messages", () => {
		const llm = getModel("openai", "gpt-4o-mini");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider Empty Messages", () => {
		const llm = getModel("openai", "gpt-5-mini");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider Empty Messages", () => {
		const llm = getModel("azure-openai-responses", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm, azureOptions);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm, azureOptions);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm, azureOptions);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm, azureOptions);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider Empty Messages", () => {
		const llm = getModel("anthropic", "claude-haiku-4-5");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.XAI_API_KEY)("xAI Provider Empty Messages", () => {
		const llm = getModel("xai", "grok-3");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq Provider Empty Messages", () => {
		const llm = getModel("groq", "openai/gpt-oss-20b");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras Provider Empty Messages", () => {
		const llm = getModel("cerebras", "gpt-oss-120b");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.CLOUDFLARE_API_KEY || !process.env.CLOUDFLARE_ACCOUNT_ID)(
		"Cloudflare Workers AI Provider Empty Messages",
		() => {
			const llm = getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6");

			it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyMessage(llm);
			});

			it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyStringMessage(llm);
			});

			it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
				await testWhitespaceOnlyMessage(llm);
			});

			it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyAssistantMessage(llm);
			});
		},
	);

	describe.skipIf(!process.env.HF_TOKEN)("Hugging Face Provider Empty Messages", () => {
		const llm = getModel("huggingface", "moonshotai/Kimi-K2.5");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.ZAI_API_KEY)("zAI Provider Empty Messages", () => {
		const llm = getModel("zai", "glm-4.5-air");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider Empty Messages", () => {
		const llm = getModel("mistral", "devstral-medium-latest");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax Provider Empty Messages", () => {
		const llm = getModel("minimax", "MiniMax-M2.7");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider Empty Messages", () => {
		const llm = getModel("kimi-coding", "kimi-k2-thinking");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway Provider Empty Messages", () => {
		const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider Empty Messages", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	// =========================================================================
	// OAuth-based providers (credentials from ~/.pi/agent/oauth.json)
	// =========================================================================

	describe("Anthropic OAuth Provider Empty Messages", () => {
		const llm = getModel("anthropic", "claude-haiku-4-5");

		it.skipIf(!anthropicOAuthToken)("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)(
			"should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testWhitespaceOnlyMessage(llm, { apiKey: anthropicOAuthToken });
			},
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testEmptyAssistantMessage(llm, { apiKey: anthropicOAuthToken });
			},
		);
	});

	describe("GitHub Copilot Provider Empty Messages", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should handle empty content array",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-4o");
				await testEmptyMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should handle empty string content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-4o");
				await testEmptyStringMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-4o");
				await testWhitespaceOnlyMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-4o");
				await testEmptyAssistantMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle empty content array",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4");
				await testEmptyMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle empty string content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4");
				await testEmptyStringMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4");
				await testWhitespaceOnlyMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4");
				await testEmptyAssistantMessage(llm, { apiKey: githubCopilotToken });
			},
		);
	});

	describe("Google Gemini CLI Provider Empty Messages", () => {
		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should handle empty content array",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-gemini-cli", "gemini-2.5-flash");
				await testEmptyMessage(llm, { apiKey: geminiCliToken });
			},
		);

		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should handle empty string content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-gemini-cli", "gemini-2.5-flash");
				await testEmptyStringMessage(llm, { apiKey: geminiCliToken });
			},
		);

		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-gemini-cli", "gemini-2.5-flash");
				await testWhitespaceOnlyMessage(llm, { apiKey: geminiCliToken });
			},
		);

		it.skipIf(!geminiCliToken)(
			"gemini-2.5-flash - should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-gemini-cli", "gemini-2.5-flash");
				await testEmptyAssistantMessage(llm, { apiKey: geminiCliToken });
			},
		);
	});

	describe("Google Antigravity Provider Empty Messages", () => {
		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should handle empty content array",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gemini-3-flash");
				await testEmptyMessage(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should handle empty string content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gemini-3-flash");
				await testEmptyStringMessage(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gemini-3-flash");
				await testWhitespaceOnlyMessage(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"gemini-3-flash - should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gemini-3-flash");
				await testEmptyAssistantMessage(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should handle empty content array",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "claude-sonnet-4-5");
				await testEmptyMessage(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should handle empty string content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "claude-sonnet-4-5");
				await testEmptyStringMessage(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "claude-sonnet-4-5");
				await testWhitespaceOnlyMessage(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"claude-sonnet-4-5 - should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "claude-sonnet-4-5");
				await testEmptyAssistantMessage(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"gpt-oss-120b-medium - should handle empty content array",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gpt-oss-120b-medium");
				await testEmptyMessage(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"gpt-oss-120b-medium - should handle empty string content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gpt-oss-120b-medium");
				await testEmptyStringMessage(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"gpt-oss-120b-medium - should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gpt-oss-120b-medium");
				await testWhitespaceOnlyMessage(llm, { apiKey: antigravityToken });
			},
		);

		it.skipIf(!antigravityToken)(
			"gpt-oss-120b-medium - should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("google-antigravity", "gpt-oss-120b-medium");
				await testEmptyAssistantMessage(llm, { apiKey: antigravityToken });
			},
		);
	});

	describe("OpenAI Codex Provider Empty Messages", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle empty content array",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await testEmptyMessage(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle empty string content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await testEmptyStringMessage(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await testWhitespaceOnlyMessage(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await testEmptyAssistantMessage(llm, { apiKey: openaiCodexToken });
			},
		);
	});
});
