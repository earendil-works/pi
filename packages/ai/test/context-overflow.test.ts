/**
 * Test context overflow error handling across providers.
 *
 * Context overflow occurs when the input (prompt + history) exceeds
 * the model's context window. This is different from output token limits.
 *
 * Expected behavior: All providers should return stopReason: "error"
 * with an errorMessage that indicates the context was too large,
 * OR (for z.ai) return successfully with usage.input > contextWindow.
 *
 * The isContextOverflow() function must return true for all providers.
 */

import type { ChildProcess } from "child_process";
import { execSync, spawn } from "child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.js";
import { isContextOverflow } from "../src/utils/overflow.js";
import { hasAzureOpenAICredentials } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { resolveApiKey } from "./oauth.js";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([resolveApiKey("github-copilot"), resolveApiKey("openai-codex")]);
const [githubCopilotToken, openaiCodexToken] = oauthTokens;

// Lorem ipsum paragraph for realistic token estimation
const LOREM_IPSUM = `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. `;

// Generate a string that will exceed the context window
// Using chars/4 as token estimate (works better with varied text than repeated chars)
function generateOverflowContent(contextWindow: number): string {
	const targetTokens = contextWindow + 10000; // Exceed by 10k tokens
	const targetChars = targetTokens * 4 * 1.5;
	const repetitions = Math.ceil(targetChars / LOREM_IPSUM.length);
	return LOREM_IPSUM.repeat(repetitions);
}

interface OverflowResult {
	provider: string;
	model: string;
	contextWindow: number;
	stopReason: string;
	errorMessage: string | undefined;
	usage: Usage;
	hasUsageData: boolean;
	response: AssistantMessage;
}

async function testContextOverflow(model: Model<any>, apiKey: string): Promise<OverflowResult> {
	const overflowContent = generateOverflowContent(model.contextWindow);

	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{
				role: "user",
				content: overflowContent,
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(model, context, { apiKey });

	const hasUsageData = response.usage.input > 0 || response.usage.cacheRead > 0;

	return {
		provider: model.provider,
		model: model.id,
		contextWindow: model.contextWindow,
		stopReason: response.stopReason,
		errorMessage: response.errorMessage,
		usage: response.usage,
		hasUsageData,
		response,
	};
}

function logResult(result: OverflowResult) {
	console.log(`\n${result.provider} / ${result.model}:`);
	console.log(`  contextWindow: ${result.contextWindow}`);
	console.log(`  stopReason: ${result.stopReason}`);
	console.log(`  errorMessage: ${result.errorMessage}`);
	console.log(`  usage: ${JSON.stringify(result.usage)}`);
	console.log(`  hasUsageData: ${result.hasUsageData}`);
}

// =============================================================================
// Anthropic
// Expected pattern: "prompt is too long: X tokens > Y maximum"
// =============================================================================

describe("Context overflow error handling", () => {
	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic (API Key)", () => {
		it("claude-haiku-4-5 - should detect overflow via isContextOverflow", async () => {
			const model = getModel("anthropic", "claude-haiku-4-5");
			const result = await testContextOverflow(model, process.env.ANTHROPIC_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/prompt is too long/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	describe.skipIf(!process.env.ANTHROPIC_OAUTH_TOKEN)("Anthropic (OAuth)", () => {
		it("claude-sonnet-4 - should detect overflow via isContextOverflow", async () => {
			const model = getModel("anthropic", "claude-sonnet-4-6");
			const result = await testContextOverflow(model, process.env.ANTHROPIC_OAUTH_TOKEN!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/prompt is too long/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// GitHub Copilot (OAuth)
	// Tests both OpenAI and Anthropic models via Copilot
	// =============================================================================

	describe("GitHub Copilot (OAuth)", () => {
		// OpenAI model via Copilot
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should detect overflow via isContextOverflow",
			async () => {
				const model = getModel("github-copilot", "gpt-4o");
				const result = await testContextOverflow(model, githubCopilotToken!);
				logResult(result);

				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toMatch(/exceeds the limit of \d+/i);
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			},
			120000,
		);

		// Anthropic model via Copilot
		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should detect overflow via isContextOverflow",
			async () => {
				const model = getModel("github-copilot", "claude-sonnet-4");
				const result = await testContextOverflow(model, githubCopilotToken!);
				logResult(result);

				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toMatch(/exceeds the limit of \d+|input is too long/i);
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			},
			120000,
		);
	});

	// =============================================================================
	// OpenAI
	// Expected pattern: "exceeds the context window"
	// =============================================================================

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions", () => {
		it("gpt-4o-mini - should detect overflow via isContextOverflow", async () => {
			const model = { ...getModel("openai", "gpt-4o-mini") };
			model.api = "openai-completions" as any;
			const result = await testContextOverflow(model, process.env.OPENAI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses", () => {
		it("gpt-4o - should detect overflow via isContextOverflow", async () => {
			const model = getModel("openai", "gpt-4o");
			const result = await testContextOverflow(model, process.env.OPENAI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/exceeds the context window/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses", () => {
		it("gpt-4o-mini - should detect overflow via isContextOverflow", async () => {
			const model = getModel("azure-openai-responses", "gpt-4o-mini");
			const result = await testContextOverflow(model, process.env.AZURE_OPENAI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/context|maximum/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Google
	// Expected pattern: "input token count (X) exceeds the maximum"
	// =============================================================================

	describe.skipIf(!process.env.GEMINI_API_KEY)("Google", () => {
		it("gemini-2.0-flash - should detect overflow via isContextOverflow", async () => {
			const model = getModel("google", "gemini-2.0-flash");
			const result = await testContextOverflow(model, process.env.GEMINI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/input token count.*exceeds the maximum/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Uses same API as Google, expects same error pattern
	// =============================================================================

	// =============================================================================
	// =============================================================================

	// =============================================================================
	// OpenAI Codex (OAuth)
	// Uses ChatGPT Plus/Pro subscription via OAuth
	// =============================================================================

	describe("OpenAI Codex (OAuth)", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should detect overflow via isContextOverflow",
			async () => {
				const model = getModel("openai-codex", "gpt-5.2-codex");
				const result = await testContextOverflow(model, openaiCodexToken!);
				logResult(result);

				expect(result.stopReason).toBe("error");
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			},
			120000,
		);
	});

	// =============================================================================
	// Amazon Bedrock
	// Expected pattern: "Input is too long for requested model"
	// =============================================================================

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock", () => {
		it("claude-sonnet-4-5 - should detect overflow via isContextOverflow", async () => {
			const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");
			const result = await testContextOverflow(model, "");
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// xAI
	// Expected pattern: "maximum prompt length is X but the request contains Y"
	// =============================================================================

	describe.skipIf(!process.env.XAI_API_KEY)("xAI", () => {
		it("grok-3-fast - should detect overflow via isContextOverflow", async () => {
			const model = getModel("xai", "grok-3-fast");
			const result = await testContextOverflow(model, process.env.XAI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum prompt length is \d+/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Groq
	// Expected pattern: "reduce the length of the messages"
	// =============================================================================

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq", () => {
		it("llama-3.3-70b-versatile - should detect overflow via isContextOverflow", async () => {
			const model = getModel("groq", "llama-3.3-70b-versatile");
			const result = await testContextOverflow(model, process.env.GROQ_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/reduce the length of the messages/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Cerebras
	// Expected: 400/413 status code with no body
	// =============================================================================

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras", () => {
		it("qwen-3-235b - should detect overflow via isContextOverflow", async () => {
			const model = getModel("cerebras", "qwen-3-235b-a22b-instruct-2507");
			const result = await testContextOverflow(model, process.env.CEREBRAS_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			// Cerebras returns status code with no body (400, 413, or 429 for token rate limit)
			expect(result.errorMessage).toMatch(/4(00|13|29).*\(no body\)/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Hugging Face
	// Uses OpenAI-compatible Inference Router
	// =============================================================================

	describe.skipIf(!process.env.HF_TOKEN)("Hugging Face", () => {
		it("Kimi-K2.5 - should detect overflow via isContextOverflow", async () => {
			const model = getModel("huggingface", "moonshotai/Kimi-K2.5");
			const result = await testContextOverflow(model, process.env.HF_TOKEN!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// z.ai
	// Special case: may return explicit overflow error text, may accept overflow silently,
	// or may rate limit instead
	// =============================================================================

	describe.skipIf(!process.env.ZAI_API_KEY)("z.ai", () => {
		it("glm-4.5-air - should detect overflow via isContextOverflow when z.ai reports it", async () => {
			const model = getModel("zai", "glm-4.5-air");
			const result = await testContextOverflow(model, process.env.ZAI_API_KEY!);
			logResult(result);

			// z.ai behavior is inconsistent:
			// - Sometimes returns explicit overflow error text via non-standard finish_reason handling
			// - Sometimes accepts overflow and returns successfully with usage.input > contextWindow
			// - Sometimes returns rate limit error
			if (result.stopReason === "error") {
				if (result.errorMessage?.match(/model_context_window_exceeded/i)) {
					expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
				} else {
					console.log("  z.ai returned non-overflow error (possibly rate limited), skipping overflow detection");
				}
			} else if (result.stopReason === "stop") {
				if (result.hasUsageData && result.usage.input > model.contextWindow) {
					expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
				} else {
					console.log("  z.ai returned stop without overflow usage data, skipping overflow detection");
				}
			}
		}, 120000);
	});

	// =============================================================================
	// Mistral
	// =============================================================================

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral", () => {
		it("devstral-medium-latest - should detect overflow via isContextOverflow", async () => {
			const model = getModel("mistral", "devstral-medium-latest");
			const result = await testContextOverflow(model, process.env.MISTRAL_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/too large for model with \d+ maximum context length/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// MiniMax
	// Expected pattern: TBD - need to test actual error message
	// =============================================================================

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax", () => {
		it("MiniMax-M2.7 - should detect overflow via isContextOverflow", async () => {
			const model = getModel("minimax", "MiniMax-M2.7");
			const result = await testContextOverflow(model, process.env.MINIMAX_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Kimi For Coding
	// =============================================================================

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding", () => {
		it("kimi-k2-thinking - should detect overflow via isContextOverflow", async () => {
			const model = getModel("kimi-coding", "kimi-k2-thinking");
			const result = await testContextOverflow(model, process.env.KIMI_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Vercel AI Gateway - Unified API for multiple providers
	// =============================================================================

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway", () => {
		it("google/gemini-2.5-flash via AI Gateway - should detect overflow via isContextOverflow", async () => {
			const model = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");
			const result = await testContextOverflow(model, process.env.AI_GATEWAY_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// OpenRouter - Multiple backend providers
	// Expected pattern: "maximum context length is X tokens"
	// =============================================================================

	describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouter", () => {
		// Anthropic backend
		it("anthropic/claude-sonnet-4 via OpenRouter - should detect overflow via isContextOverflow", async () => {
			const model = getModel("openrouter", "anthropic/claude-sonnet-4");
			const result = await testContextOverflow(model, process.env.OPENROUTER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length is \d+ tokens/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);

		// DeepSeek backend
		it("deepseek/deepseek-v3.2 via OpenRouter - should detect overflow via isContextOverflow", async () => {
			const model = getModel("openrouter", "deepseek/deepseek-v3.2");
			const result = await testContextOverflow(model, process.env.OPENROUTER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length is \d+ tokens/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);

		// Mistral backend
		it("mistralai/mistral-large-2512 via OpenRouter - should detect overflow via isContextOverflow", async () => {
			const model = getModel("openrouter", "mistralai/mistral-large-2512");
			const result = await testContextOverflow(model, process.env.OPENROUTER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length is \d+ tokens/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);

		// Google backend
		it("google/gemini-2.5-flash via OpenRouter - should detect overflow via isContextOverflow", async () => {
			const model = getModel("openrouter", "google/gemini-2.5-flash");
			const result = await testContextOverflow(model, process.env.OPENROUTER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length is \d+ tokens/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);

		// Meta/Llama backend
		it("meta-llama/llama-4-scout via OpenRouter - should detect overflow via isContextOverflow", async () => {
			const model = getModel("openrouter", "meta-llama/llama-4-scout");
			const result = await testContextOverflow(model, process.env.OPENROUTER_API_KEY!);
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/maximum context length is \d+ tokens/i);
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// Ollama (local)
	// =============================================================================

	// Check if ollama is installed and local LLM tests are enabled
	let ollamaInstalled = false;
	if (!process.env.PI_NO_LOCAL_LLM) {
		try {
			execSync("which ollama", { stdio: "ignore" });
			ollamaInstalled = true;
		} catch {
			ollamaInstalled = false;
		}
	}

	describe.skipIf(!ollamaInstalled)("Ollama (local)", () => {
		let ollamaProcess: ChildProcess | null = null;
		let model: Model<"openai-completions">;

		beforeAll(async () => {
			// Check if model is available, if not pull it
			try {
				execSync("ollama list | grep -q 'gpt-oss:20b'", { stdio: "ignore" });
			} catch {
				console.log("Pulling gpt-oss:20b model for Ollama overflow tests...");
				try {
					execSync("ollama pull gpt-oss:20b", { stdio: "inherit" });
				} catch (_e) {
					console.warn("Failed to pull gpt-oss:20b model, tests will be skipped");
					return;
				}
			}

			// Start ollama server
			ollamaProcess = spawn("ollama", ["serve"], {
				detached: false,
				stdio: "ignore",
			});

			// Wait for server to be ready
			await new Promise<void>((resolve) => {
				const checkServer = async () => {
					try {
						const response = await fetch("http://localhost:11434/api/tags");
						if (response.ok) {
							resolve();
						} else {
							setTimeout(checkServer, 500);
						}
					} catch {
						setTimeout(checkServer, 500);
					}
				};
				setTimeout(checkServer, 1000);
			});

			model = {
				id: "gpt-oss:20b",
				api: "openai-completions",
				provider: "ollama",
				baseUrl: "http://localhost:11434/v1",
				reasoning: true,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 16000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				name: "Ollama GPT-OSS 20B",
			};
		}, 60000);

		afterAll(() => {
			if (ollamaProcess) {
				ollamaProcess.kill("SIGTERM");
				ollamaProcess = null;
			}
		});

		it("gpt-oss:20b - should detect overflow via isContextOverflow (ollama silently truncates)", async () => {
			const result = await testContextOverflow(model, "ollama");
			logResult(result);

			// Ollama silently truncates input instead of erroring
			// It returns stopReason "stop" with truncated usage
			// We cannot detect overflow via error message, only via usage comparison
			if (result.stopReason === "stop" && result.hasUsageData) {
				// Ollama truncated - check if reported usage is less than what we sent
				// This is a "silent overflow" - we can detect it if we know expected input size
				console.log("  Ollama silently truncated input to", result.usage.input, "tokens");
				// For now, we accept this behavior - Ollama doesn't give us a way to detect overflow
			} else if (result.stopReason === "error") {
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			}
		}, 300000); // 5 min timeout for local model
	});

	// =============================================================================
	// LM Studio (local) - Skip if not running or local LLM tests disabled
	// =============================================================================

	let lmStudioRunning = false;
	if (!process.env.PI_NO_LOCAL_LLM) {
		try {
			execSync("curl -s --max-time 1 http://localhost:1234/v1/models > /dev/null", { stdio: "ignore" });
			lmStudioRunning = true;
		} catch {
			lmStudioRunning = false;
		}
	}

	describe.skipIf(!lmStudioRunning)("LM Studio (local)", () => {
		it("should detect overflow via isContextOverflow", async () => {
			const model: Model<"openai-completions"> = {
				id: "local-model",
				api: "openai-completions",
				provider: "lm-studio",
				baseUrl: "http://localhost:1234/v1",
				reasoning: false,
				input: ["text"],
				contextWindow: 8192,
				maxTokens: 2048,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				name: "LM Studio Local Model",
			};

			const result = await testContextOverflow(model, "lm-studio");
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});

	// =============================================================================
	// llama.cpp server (local) - Skip if not running or not exposing /v1/completions
	// =============================================================================

	let llamaCppRunning = false;
	if (!process.env.PI_NO_LOCAL_LLM) {
		try {
			execSync("curl -s --max-time 1 http://localhost:8081/health > /dev/null", { stdio: "ignore" });
			const probeStatus = execSync(
				'curl -s --max-time 1 -o /dev/null -w \'%{http_code}\' -X POST http://localhost:8081/v1/completions -H \'content-type: application/json\' -d \'{"model":"local-model","prompt":"ping","max_tokens":1}\'',
				{ encoding: "utf8" },
			).trim();
			llamaCppRunning = probeStatus !== "404" && probeStatus !== "405" && probeStatus !== "000";
		} catch {
			llamaCppRunning = false;
		}
	}

	describe.skipIf(!llamaCppRunning)("llama.cpp (local)", () => {
		it("should detect overflow via isContextOverflow", async () => {
			// Using small context (4096) to match server --ctx-size setting
			const model: Model<"openai-completions"> = {
				id: "local-model",
				api: "openai-completions",
				provider: "llama.cpp",
				baseUrl: "http://localhost:8081/v1",
				reasoning: false,
				input: ["text"],
				contextWindow: 4096,
				maxTokens: 2048,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				name: "llama.cpp Local Model",
			};

			const result = await testContextOverflow(model, "llama.cpp");
			logResult(result);

			expect(result.stopReason).toBe("error");
			expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
		}, 120000);
	});
});
